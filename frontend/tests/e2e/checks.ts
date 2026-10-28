/**
 * The gate's measurements, each run in the page: axe, target sizes, reflow,
 * motion, and where keyboard focus lands. Each returns data; the specs decide
 * what fails.
 */
import { inflateSync } from "node:zlib";
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";

/** The engine a page runs in: "chromium", "webkit" or "firefox". */
export const engine = (page: Page) => page.context().browser()!.browserType().name();

/**
 * The key that takes a keyboard user to the next control, or with `back` to the one before. Safari on a Mac gives Tab to
 * text fields and lists only and Option+Tab to every control (its setting "Press Tab to highlight each item" swaps the
 * two); the gate walks every control, so it presses the one that reaches them all.
 */
export const tabKey = (page: Page, back = false) =>
  `${engine(page) === "webkit" && process.platform === "darwin" ? "Alt+" : ""}${back ? "Shift+" : ""}Tab`;

/** WCAG 1.4.12: the spacing a reader may set. Nothing may be cut off, covered or moved out of reach by it. */
export const TEXT_SPACING =
  "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }";

/**
 * Adds a stylesheet to the page the way the strict `style-src 'self'` allows: a constructable one, adopted by the
 * document. `page.addStyleTag` makes a <style> element, which the policy blocks, and a block is a violation. Returns what
 * takes it away again.
 */
export async function addStyles(page: Page, css: string) {
  await page.evaluate((css) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    (window as unknown as { __addedStyles: CSSStyleSheet[] }).__addedStyles = [...((window as unknown as { __addedStyles?: CSSStyleSheet[] }).__addedStyles ?? []), sheet];
  }, css);
  return () =>
    page.evaluate(() => {
      const added = (window as unknown as { __addedStyles?: CSSStyleSheet[] }).__addedStyles ?? [];
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => !added.includes(sheet));
    });
}

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

/**
 * Waits for opening animations (a dialog fading in), colour transitions and smooth scrolls to end, so colours are
 * measured at rest and targets where they stay.
 */
export async function settle(page: Page) {
  // Animations and transitions both: a colour fading to its end would be measured halfway. A live page keeps
  // starting new ones (a recording's level and timer), so only those running now are waited for, a few seconds
  // at most.
  await Promise.all([
    page.evaluate(() =>
      Promise.race([
        Promise.all(
          document
            .getAnimations()
            .filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => undefined)),
        ),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]),
    ),
    scrollsAtRest(page),
  ]);
}

/**
 * Waits until three frames in a row see the page's scrolling boxes where they were, and no scroll that has begun is
 * still on its way, a few seconds at most. A smooth scroll (a step to the next passage, an engine's own reveal of what
 * Tab focused) carries what it scrolls past a pinned bar: measured on its way, a target is measured under the bar, and a
 * focused control outside the window. A smooth scroll starts a frame after it is asked for, hence three frames; and
 * Firefox reports a scroll position in whole pixels while its scroll eases on by less than one a frame, so a scroll
 * that has begun has ended only at its `scrollend`.
 */
export function scrollsAtRest(page: Page) {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const boxes = [document.scrollingElement, ...document.querySelectorAll("*")].filter(
          (el): el is Element => el !== null && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth),
        );
        const at = () => boxes.map((el) => `${el.scrollLeft},${el.scrollTop}`).join(";");
        const end = performance.now() + 5_000;
        let last = at();
        let still = 0;
        // A box's scroll and scrollend do not bubble; listened for on the way down, they are heard from every box.
        let moving = false;
        const scrolled = () => void (moving = "onscrollend" in window);
        const ended = () => void (moving = false);
        addEventListener("scroll", scrolled, true);
        addEventListener("scrollend", ended, true);
        const frame = () => {
          const now = at();
          still = now === last ? still + 1 : 0;
          last = now;
          if ((still >= 3 && !moving) || performance.now() > end) {
            removeEventListener("scroll", scrolled, true);
            removeEventListener("scrollend", ended, true);
            resolve();
          } else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
  );
}

export async function axe(page: Page) {
  await settle(page);
  const result = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return {
    violations: result.violations.map((v) => ({
      id: v.id,
      impact: v.impact ?? null,
      tags: v.tags,
      help: v.help,
      nodes: v.nodes.map((n) => ({ target: n.target.join(" "), summary: n.failureSummary ?? "" })),
    })),
    incomplete: result.incomplete.map((v) => ({ id: v.id, help: v.help, nodes: v.nodes.length })),
    // Text whose contrast axe could not decide (a gradient behind it, something over or under it), with its reason:
    // measured on the screen's pixels instead (undecidedContrast). A target inside a frame or a shadow root is not.
    undecidedText: (result.incomplete.find((v) => v.id === "color-contrast")?.nodes ?? []).flatMap((n) =>
      n.target.length === 1 && typeof n.target[0] === "string"
        ? [{ target: n.target[0], reason: String((n.any[0]?.data as { messageKey?: string } | null)?.messageKey ?? "") }]
        : [],
    ),
  };
}

/** axe's reasons for an undecided text colour that are no text to read: a glyph from an icon font (outside the BMP). */
const NOT_TEXT = new Set(["nonBmp"]);

/** A PNG screenshot's pixels, RGBA: Playwright's are 8-bit, RGB or RGBA, not interlaced. */
function pixelsOf(png: Buffer) {
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const data: Buffer[] = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const kind = png.toString("ascii", at + 4, at + 8);
    const chunk = png.subarray(at + 8, at + 8 + length);
    if (kind === "IHDR") {
      [width, height] = [chunk.readUInt32BE(0), chunk.readUInt32BE(4)];
      if (chunk[8] !== 8 || chunk[12] !== 0 || (chunk[9] !== 2 && chunk[9] !== 6)) throw new Error("not an 8-bit, non-interlaced RGB(A) PNG");
      channels = chunk[9] === 6 ? 4 : 3;
    }
    if (kind === "IDAT") data.push(chunk);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  let above = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = above[x];
      const corner = x >= channels ? above[x - channels] : 0;
      const p = left + up - corner;
      const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)];
      const predicted = [0, left, up, (left + up) >> 1, pa <= pb && pa <= pc ? left : pb <= pc ? up : corner][filter];
      row[x] = (line[x] + predicted) & 0xff;
    }
    for (let x = 0; x < width; x += 1) rgba.set([row[x * channels], row[x * channels + 1], row[x * channels + 2], channels === 4 ? row[x * channels + 3] : 255], (y * width + x) * 4);
    above = row;
  }
  return { width, height, rgba };
}

const luminance = ([r, g, b]: readonly number[]) => {
  const channel = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

/**
 * The text axe left undecided, measured as a person sees it: its box captured three times, the text drawn in black, in
 * white and in no colour. Where a letter stands the black and the white differ, whatever is behind it; what the box shows
 * there without the text is the background behind the text (WCAG 1.4.3), and the worst of it against the text's own
 * colour is the ratio. The rest of the box decides nothing, so text whose letters partly stand on a ground of their own
 * colour fails however much of the box is clear. Words inside it in a colour of their own are their own text and keep
 * it. Each with the ratio it needs (4.5:1, or 3:1 for large text: 24 px, or 18.66 px bold). A glyph is not measured, nor
 * text that something else covers where it stands or that is drawn in no colour.
 */
export async function undecidedContrast(page: Page, undecided: { target: string; reason: string }[]) {
  const measured: { target: string; reason: string; ratio: number; needed: number; text: number[]; behind: number[] }[] = [];
  const remove = await addStyles(
    page,
    `[data-contrast-probe] { text-shadow: none !important; text-decoration-color: transparent !important; }
     [data-contrast-probe="dark"] { color: #000 !important; -webkit-text-fill-color: #000 !important; }
     [data-contrast-probe="light"] { color: #fff !important; -webkit-text-fill-color: #fff !important; }
     [data-contrast-probe="none"] { color: transparent !important; -webkit-text-fill-color: transparent !important; }
     [data-contrast-probe] * { -webkit-text-fill-color: currentcolor !important; }
     [data-contrast-probe], [data-contrast-probe] * { transition: none !important; }`,
  );
  try {
    for (const { target, reason } of undecided.filter((item) => !NOT_TEXT.has(item.reason))) {
      const element = page.locator(target).first();
      const seen = await element
        .evaluate((node) => {
          const style = getComputedStyle(node);
          const box = node.getBoundingClientRect();
          const left = Math.max(0, box.left);
          const top = Math.max(0, box.top);
          const right = Math.min(innerWidth, box.right);
          const bottom = Math.min(innerHeight, box.bottom);
          if (right - left < 1 || bottom - top < 1 || style.visibility === "hidden") return null;
          // Behind an open modal dialog, or inert: out of reach while the dialog is open, as targetSizes counts it.
          const modal = document.querySelector("dialog:modal");
          if ((modal && !modal.contains(node)) || (node.closest("[inert]") && !node.closest("dialog:modal"))) return null;
          // Under something else at its middle (a popover over the page): no text to read there, so nothing to measure.
          const stack = document.elementsFromPoint((left + right) / 2, (top + bottom) / 2);
          const at = stack.findIndex((element) => element === node || node.contains(element));
          if (at > 0 && stack.slice(0, at).some((element) => !element.contains(node))) return null;
          const context = document.createElement("canvas").getContext("2d")!;
          context.fillStyle = style.color;
          context.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
          // Text drawn in no colour (a field whose value another layer shows, as the design system's date field's): none to read.
          if (a === 0) return null;
          const size = parseFloat(style.fontSize);
          return { clip: { x: left, y: top, width: right - left, height: bottom - top }, text: [r, g, b, a / 255], large: size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700) };
        })
        .catch(() => null);
      if (!seen) continue;
      try {
        const shot = async (probe: string) => {
          await element.evaluate((node, probe) => node.setAttribute("data-contrast-probe", probe), probe);
          return pixelsOf(await page.screenshot({ clip: seen.clip, animations: "disabled", caret: "hide" })).rgba;
        };
        const [dark, light, bare] = [await shot("dark"), await shot("light"), await shot("none")];
        // A letter's pixel: black and white text differ there by more than 8 of 255 (its edge's faintest shade aside).
        const letters = Array.from({ length: bare.length / 4 }, (_, i) => i).filter((i) => Math.abs(dark[i * 4] - light[i * 4]) > 8);
        // No letter drawn in the box (covered, or cut off): no text to read.
        if (!letters.length) continue;
        const [r, g, b, a] = seen.text;
        let worst = { ratio: Infinity, text: [] as number[], behind: [] as number[] };
        for (const i of letters) {
          const behind = [bare[i * 4], bare[i * 4 + 1], bare[i * 4 + 2]];
          const text = [r * a + behind[0] * (1 - a), g * a + behind[1] * (1 - a), b * a + behind[2] * (1 - a)].map(Math.round);
          const [hi, lo] = [luminance(text), luminance(behind)].sort((p, q) => q - p);
          const ratio = (hi + 0.05) / (lo + 0.05);
          if (ratio < worst.ratio) worst = { ratio, text, behind };
        }
        measured.push({ target, reason, ratio: Math.round(worst.ratio * 100) / 100, needed: seen.large ? 3 : 4.5, text: worst.text, behind: worst.behind });
      } finally {
        await element.evaluate((node) => node.removeAttribute("data-contrast-probe")).catch(() => undefined);
      }
    }
  } finally {
    await remove();
  }
  return measured;
}

/** What fails the gate: every WCAG violation whatever its impact, and best practice when serious or critical. */
export const blocking = <T extends { impact: string | null; tags: string[] }>(violations: T[]) =>
  violations.filter(
    (v) => v.tags.some((tag) => /^wcag\d/.test(tag)) || v.impact === "serious" || v.impact === "critical",
  );

/**
 * Targets below `min` CSS px. A target's area is its box (grown by an
 * absolutely placed ::after, as the chip remove button does), any label that
 * activates it, and for a slider the whole track. With `spacing`, WCAG 2.5.8's
 * exceptions apply: an undersized target passes when a 24 px circle on it
 * touches no other target, and a target inside a sentence passes.
 */
export function targetSizes(page: Page, min: number, spacing: boolean) {
  return page.evaluate(
    ([min, spacing]) => {
      const SELECTOR =
        'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], [role="combobox"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="option"], .astryx-radio-list-item';
      type Box = { left: number; top: number; right: number; bottom: number };
      const box = (r: DOMRect | Box): Box => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      const shown = (el: Element) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        // An open modal dialog is in reach whatever its ancestors say: it leaves an inert ancestor's inertness.
        const outOfReach = el.closest('[aria-hidden="true"], [hidden]') !== null || (el.closest("[inert]") !== null && el.closest("dialog:modal") === null);
        return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && Number(s.opacity) > 0 && !outOfReach;
      };
      const parts = (el: HTMLElement): Box[] => {
        const own = box(el.getBoundingClientRect());
        const out = [own];
        const after = getComputedStyle(el, "::after");
        if (after.content !== "none" && after.position === "absolute") {
          // An absolutely placed ::after is laid out from its element's padding box, inside the border.
          const s = getComputedStyle(el);
          const px = (v: string) => (v.endsWith("px") ? parseFloat(v) : 0);
          out.push({
            left: own.left + px(s.borderLeftWidth) + px(after.left),
            top: own.top + px(s.borderTopWidth) + px(after.top),
            right: own.right - px(s.borderRightWidth) - px(after.right),
            bottom: own.bottom - px(s.borderBottomWidth) - px(after.bottom),
          });
        }
        // A field's box takes the click for the control inside it (the design system's inputs and pickers).
        // The date field's box does too on a touch device: a tap inside it above the input focuses the input (measured on the
        // stub's date flow, 390 px wide), so the 44 px box, not the 24 px input line, is what a finger meets.
        const fieldBox = el.matches('input, textarea, [role="combobox"]')
          ? el.closest('.astryx-text-input, .astryx-text-area, .astryx-number-input, .astryx-date-input, .astryx-selector, .astryx-typeahead, .astryx-tokenizer')
          : null;
        if (fieldBox) out.push(box(fieldBox.getBoundingClientRect()));
        const labels = (el as HTMLInputElement).labels;
        if (labels) for (const label of Array.from(labels)) out.push(box(label.getBoundingClientRect()));
        if (el.getAttribute("role") === "slider") {
          // The thumb is small by design; a press anywhere on the slider's control moves it. The control is the box
          // (its rail is 4 px and hidden from the tree).
          const control = el.parentElement?.closest(".astryx-slider-control, [data-orientation]");
          if (control) out.push(box(control.getBoundingClientRect()));
        }
        return out;
      };
      const big = (b: Box) => b.right - b.left >= min - 0.5 && b.bottom - b.top >= min - 0.5;
      // In a sentence: the target sits among the parent's own words.
      const inSentence = (el: Element) =>
        !["block", "flex", "grid"].includes(getComputedStyle(el).display) &&
        Array.from(el.parentElement?.childNodes ?? []).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
      const describe = (el: HTMLElement) => {
        const name = el.getAttribute("aria-label") ?? (el as HTMLInputElement).labels?.[0]?.textContent ?? el.textContent ?? "";
        return `${el.getAttribute("role") ?? el.tagName.toLowerCase()} "${name.trim().slice(0, 50)}"`;
      };

      const targets = Array.from(document.querySelectorAll<HTMLElement>(SELECTOR)).filter(shown);
      const small = targets.filter((el) => !parts(el).some(big) && !(spacing && inSentence(el)));
      const centre = (b: Box) => [(b.left + b.right) / 2, (b.top + b.bottom) / 2];
      const distance = ([x, y]: number[], b: Box) =>
        Math.hypot(Math.max(b.left - x, 0, x - b.right), Math.max(b.top - y, 0, y - b.bottom));
      return small
        .filter((el) => {
          if (!spacing) return true;
          // WCAG 2.5.8 spacing: a 24 px circle on the target meets no other target, nor another small one's circle.
          const c = centre(box(el.getBoundingClientRect()));
          return targets.some((other) => {
            if (other === el || other.contains(el) || el.contains(other)) return false;
            const b = box(other.getBoundingClientRect());
            return distance(c, b) < 12 || (small.includes(other) && Math.hypot(c[0] - centre(b)[0], c[1] - centre(b)[1]) < 24);
          });
        })
        .map((el) => {
          const r = el.getBoundingClientRect();
          return `${describe(el)} ${Math.round(r.width)}×${Math.round(r.height)}`;
        });
    },
    [min, spacing] as const,
  );
}

const CONTROLS = new Set(["button", "link", "radio", "checkbox", "switch", "slider", "combobox", "textbox", "searchbox", "spinbutton", "menuitem", "menuitemradio", "menuitemcheckbox", "tab", "option", "listbox"]);

/**
 * Controls without a name in Chromium's own accessibility tree, the one screen readers get (WCAG 4.1.2). Read over the
 * DevTools protocol, which only Chromium speaks: in the other engines a missing name is axe's to find.
 */
export async function unnamedControls(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as {
    nodes: { ignored: boolean; role?: { value: string }; name?: { value: string }; backendDOMNodeId?: number }[];
  };
  const unnamed = nodes.filter((n) => !n.ignored && CONTROLS.has(n.role?.value ?? "") && !String(n.name?.value ?? "").trim());
  const described = await Promise.all(
    unnamed.map(async (n) => {
      const { node } = (await cdp.send("DOM.describeNode", { backendNodeId: n.backendDOMNodeId })) as {
        node: { localName: string; attributes?: string[] };
      };
      const attributes = node.attributes ?? [];
      const id = attributes[attributes.indexOf("id") + 1];
      return `${n.role!.value} <${node.localName}${attributes.includes("id") ? ` id="${id}"` : ""}>`;
    }),
  );
  await cdp.detach();
  return described;
}

type AxProperty = { name: string; value: { value?: unknown } };
// A toggle's off is said as much as its on; the others are said only when they hold.
const TOGGLES = ["checked", "pressed", "expanded", "selected"];
const FLAGS = ["disabled", "invalid", "required", "readonly", "busy"];

/** The states a screen reader reads out, from Chromium's properties: "checked=true", "expanded=false" and so on. */
function axState(properties: AxProperty[] = []): string {
  return properties
    .filter((p) => p.value.value !== undefined && (TOGGLES.includes(p.name) || (FLAGS.includes(p.name) && ![false, "false"].includes(p.value.value as string))))
    .map((p) => `${p.name}=${String(p.value.value)}`)
    .join(" ");
}

/** The role, name, description and states Chromium's own tree gives one element, the ones a screen reader reads. Chromium only. */
export async function axNode(locator: Locator) {
  const page = locator.page();
  await locator.evaluate((element) => element.setAttribute("data-ax-probe", ""));
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = (await cdp.send("DOM.getDocument", { depth: 0 })) as { root: { nodeId: number } };
    const { nodeId } = (await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "[data-ax-probe]" })) as {
      nodeId: number;
    };
    const { nodes } = (await cdp.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false })) as {
      nodes: { role?: { value: string }; name?: { value: string }; description?: { value: string }; properties?: AxProperty[] }[];
    };
    const [node] = nodes;
    return { role: node.role?.value ?? "", name: node.name?.value ?? "", description: node.description?.value ?? "", state: axState(node.properties) || undefined };
  } finally {
    await cdp.detach();
    await locator.evaluate((element) => element.removeAttribute("data-ax-probe"));
  }
}

/**
 * WCAG 1.4.10: no horizontal scroll, no text or control past the window's left or right edge, nothing cut off by a box that
 * clips it (wider or taller than its overflow-hidden ancestor); ellipsis is listed apart.
 */
export function reflow(page: Page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const describe = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""} "${(el.textContent ?? "").trim().slice(0, 50)}"`;
    const beyond: string[] = [];
    const clipped: string[] = [];
    const truncated: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || s.visibility === "hidden" || el.closest('[aria-hidden="true"]')) continue;
      // Visually hidden text for screen readers is meant to be clipped.
      if (s.position === "absolute" && (s.clip !== "auto" || r.width <= 1)) continue;
      const scrollsX = (e: Element | null): boolean =>
        !!e && e !== document.body && (["auto", "scroll"].includes(getComputedStyle(e).overflowX) || scrollsX(e.parentElement));
      const text = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
      const outside = r.right > width + 1 || r.left < -1;
      if (outside && (text || el.matches("button, a, input, select, textarea, img, svg")) && !scrollsX(el.parentElement)) {
        beyond.push(describe(el));
      }
      const cutX = ["hidden", "clip"].includes(s.overflowX) && el.scrollWidth > el.clientWidth + 1;
      const cutY = ["hidden", "clip"].includes(s.overflowY) && el.scrollHeight > el.clientHeight + 1;
      // A text field scrolls its own text.
      if ((!cutX && !cutY) || el.matches("input, textarea, select")) continue;
      const clamped = s.textOverflow === "ellipsis" || (s.webkitLineClamp !== "none" && s.webkitLineClamp !== "");
      (clamped ? truncated : clipped).push(describe(el));
    }
    return { horizontalScroll: document.documentElement.scrollWidth > width + 1, beyond, clipped, truncated };
  });
}

/** Placeholder text under 4.5:1 on its field (WCAG 1.4.3), which axe does not measure. */
export function placeholderContrast(page: Page) {
  return page.evaluate(() => {
    type Rgba = [number, number, number, number];
    // A computed colour as the browser paints it: a mix or an alpha token computes to color(srgb …), whose 0–1 channels a
    // pattern for rgb() would read as near-black.
    const paint = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const rgba = (color: string): Rgba => {
      paint.clearRect(0, 0, 1, 1);
      paint.fillStyle = color;
      paint.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = ([r, g, b, a]: Rgba, [R, G, B]: Rgba): Rgba => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];
    const luminance = ([r, g, b]: Rgba) =>
      [r, g, b].map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const background = (e: Element | null): Rgba => {
      if (!e) return [255, 255, 255, 1];
      const own = rgba(getComputedStyle(e).backgroundColor);
      return own[3] >= 0.99 ? own : over(own, background(e.parentElement));
    };
    return Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input[placeholder], textarea[placeholder]"))
      .filter((el) => el.placeholder && !el.value && el.getBoundingClientRect().width > 1 && !el.closest('[aria-hidden="true"], [inert]'))
      .flatMap((el) => {
        const back = background(el);
        const [hi, lo] = [luminance(over(rgba(getComputedStyle(el, "::placeholder").color), back)), luminance(back)].sort((a, b) => b - a);
        const ratio = (hi + 0.05) / (lo + 0.05);
        return ratio < 4.5 ? [`${el.tagName.toLowerCase()} "${el.placeholder}" ${ratio.toFixed(2)}:1`] : [];
      });
  });
}

/** Animations that loop forever; with reduced motion there should be none. */
export function endlessAnimations(page: Page) {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations === Infinity)
      .map((a) => {
        const target = (a.effect as KeyframeEffect | null)?.target as Element | null;
        return `${(a as CSSAnimation).animationName ?? "animation"} on ${target?.tagName.toLowerCase()}.${(target?.getAttribute("class") ?? "").split(" ").slice(0, 3).join(".")}`;
      }),
  );
}

/**
 * Animations and transitions running now that move something: its place, its scale or its turn. With reduced motion the
 * page may still change a colour, an opacity or a bar's length, never move what is on screen (WCAG 2.3.3, the house bar).
 */
export function movingAnimations(page: Page) {
  return page.evaluate(() => {
    const moves = /^(transform|translate|scale|rotate|top|left|right|bottom|inset|margin)/;
    const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    return document
      .getAnimations()
      .filter((animation) => animation.playState === "running")
      .flatMap((animation) => {
        const effect = animation.effect as KeyframeEffect | null;
        const properties =
          animation instanceof CSSTransition ? [animation.transitionProperty] : (effect?.getKeyframes() ?? []).flatMap((frame) => Object.keys(frame).map(kebab));
        const moving = [...new Set(properties.filter((property) => moves.test(property)))];
        if (!moving.length) return [];
        const target = effect?.target as Element | null;
        return [`${moving.join(", ")} on ${target?.tagName.toLowerCase()}.${(target?.getAttribute("class") ?? "").split(" ").slice(0, 3).join(".")}`];
      });
  });
}

export interface FocusStop {
  key: string;
  label: string;
  /** False unless focus changes, by 3:1 or more, at least a one-pixel line's worth around the element. */
  indicator: boolean;
  /** CSS px² that focus changes by 3:1 or more, and the element's perimeter it is held against. */
  indicatorArea: number;
  perimeter: number;
  focusVisible: boolean;
  /** "full": other content hides it all (WCAG 2.4.11); "partial": a pinned bar covers part of it (house bar). */
  obscured: "none" | "partial" | "full";
  coveredBy: string | null;
  offscreen: boolean;
  /** Inside a sticky or fixed box (the recording bar, a dialog). */
  pinned: boolean;
  inDialog: boolean;
  /** The nearest focusable container it sits in (the transcript region), if any. */
  container: string | null;
  /** The box in document coordinates, for the reading order. */
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** The indicator's owner kept moving while it was measured, every time: the ring could not be measured. */
  unsettled?: boolean;
}

/**
 * Where focus is now, or null when it left the page (the end of the tab order).
 * The focus indicator is measured as rendered: screenshots of the indicator's
 * owner (the outermost near box whose look changes) with and without focus, and
 * the pixels that change by 3:1 or more must add up to at least a one-pixel
 * line around the element. An outline the eye cannot see is no indicator.
 */
export async function focusStop(page: Page): Promise<FocusStop | null> {
  // A page that moves while its ring is photographed (a live status line, a level meter, a list arriving) puts part of
  // the ring outside the clip: a measurement counts only when the owner stood still through both screenshots, and is
  // taken again from a fresh probe when it did not.
  let waited = false;
  for (let attempt = 1; ; attempt++) {
    const stop = await probeFocus(page);
    if (!stop) return null;
    // An engine can bring what Tab focused into the window with a scroll of its own that is still on its way (WebKit on a
    // loaded Linux runner): a control outside the window is probed again once the page stands still. One that the
    // engine never brings in is still outside then.
    if (stop.offscreen && !waited) {
      waited = true;
      await scrollsAtRest(page);
      continue;
    }
    const { owner, perimeter, ...rest } = stop;
    let area = owner === null ? 0 : await seenChange(page);
    // Firefox can take two identical screenshots of a ring its styles show, so a miss is measured once more: a ring
    // that is missing is missing both times.
    if (owner !== null && area !== null && area < perimeter) area = await seenChange(page);
    if (area === null && attempt < SETTLE_ATTEMPTS) continue;
    const measured = area ?? 0;
    return { ...rest, indicator: measured >= perimeter, indicatorArea: Math.round(measured), perimeter: Math.round(perimeter), ...(area === null ? { unsettled: true } : {}) };
  }
}

/** How many fresh probes a stop gets while its owner keeps moving under the screenshots. */
const SETTLE_ATTEMPTS = 5;

/** The owner probeFocus marked, where it is now; null when it is gone. */
const ownerBox = (page: Page): Promise<Rect | null> =>
  page.evaluate(() => {
    const box = document.querySelector("[data-a11y-owner]")?.getBoundingClientRect();
    return box ? { x: box.left, y: box.top, width: box.width, height: box.height } : null;
  });

const sameBox = (a: Rect | null, b: Rect | null) =>
  a !== null && b !== null && Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) <= 0.5 && Math.abs(a.width - b.width) <= 0.5 && Math.abs(a.height - b.height) <= 0.5;

export type Rect = { x: number; y: number; width: number; height: number };

/**
 * How much of the owner's rendering focus changes by 3:1 or more, in CSS px², read where the owner is now; null when it
 * moved between the screenshots, which then compare two different places.
 */
async function seenChange(page: Page): Promise<number | null> {
  const box = await ownerBox(page);
  if (!box) return 0;
  const clip = await screenClip(page, box);
  if (!clip) return 0;
  const withFocus = await shot(page, clip);
  await page.evaluate(() => (window as unknown as { a11yRest: () => Promise<void> }).a11yRest());
  const without = await shot(page, clip);
  await page.evaluate(() => {
    const current = document.querySelector("[data-a11y-current]") as HTMLElement | null;
    current?.style.removeProperty("outline");
    current?.focus({ preventScroll: true });
  });
  if (!sameBox(box, await ownerBox(page))) return null;
  return changedArea(page, withFocus, without, clip.width);
}

/** Where a box read by a script is on the screenshot, with room for a ring around it; null when off screen. */
export async function screenClip(page: Page, box: Rect): Promise<Rect | null> {
  // A phone's page wider than its screen widens the layout viewport, and the screen (the visual viewport) then
  // scrolls inside it: the box a script reads is moved to where the screenshot sees it.
  const shift = await page.evaluate(() => ({ x: visualViewport?.offsetLeft ?? 0, y: visualViewport?.offsetTop ?? 0 }));
  const owner = { ...box, x: box.x - shift.x, y: box.y - shift.y };
  // Outlines and rings sit up to a few pixels outside the box.
  const viewport = page.viewportSize()!;
  const x = Math.max(0, Math.floor(owner.x - 6)), y = Math.max(0, Math.floor(owner.y - 6));
  const clip = {
    x,
    y,
    width: Math.min(viewport.width, Math.ceil(owner.x + owner.width + 6)) - x,
    height: Math.min(viewport.height, Math.ceil(owner.y + owner.height + 6)) - y,
  };
  return clip.width > 0 && clip.height > 0 ? clip : null;
}

export const shot = (page: Page, clip: Rect) =>
  page.screenshot({ clip, animations: "disabled", caret: "hide" }).then((png) => png.toString("base64"));

/** The area, in CSS px², whose luminance differs by 3:1 or more between two screenshots of one clip. */
export function changedArea(page: Page, a: string, b: string, clipWidth: number): Promise<number> {
  return page.evaluate(
    async ([a, b, clipWidth]) => {
      const pixels = async (base64: string) => {
        // Decoded from its bytes: a data: URL would be an image the page's policy does not allow.
        const image = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))], { type: "image/png" }));
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return { data: context.getImageData(0, 0, image.width, image.height).data, width: image.width };
      };
      const [focused, resting] = await Promise.all([pixels(a), pixels(b)]);
      const channel = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
      const luminance = (d: Uint8ClampedArray, i: number) => 0.2126 * channel(d[i]) + 0.7152 * channel(d[i + 1]) + 0.0722 * channel(d[i + 2]);
      let strong = 0;
      for (let i = 0; i < focused.data.length; i += 4) {
        const [hi, lo] = [luminance(focused.data, i), luminance(resting.data, i)].sort((p, q) => q - p);
        if ((hi + 0.05) / (lo + 0.05) >= 3) strong++;
      }
      // Screenshot pixels per CSS pixel: the device pixel ratio.
      const scale = focused.width / clipWidth;
      return strong / (scale * scale);
    },
    [a, b, clipWidth] as const,
  );
}

function probeFocus(page: Page) {
  return page.evaluate(async () => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement) return null;
    el.dataset.a11yStop ??= String(Math.random()).slice(2);
    document.querySelectorAll("[data-a11y-current]").forEach((e) => e.removeAttribute("data-a11y-current"));
    el.setAttribute("data-a11y-current", "");
    type Rgba = [number, number, number, number];
    // A computed colour as the browser paints it: a mix or an alpha token computes to color(srgb …), whose 0–1 channels a
    // pattern for rgb() would read as near-black.
    const paint = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const rgba = (color: string): Rgba => {
      paint.clearRect(0, 0, 1, 1);
      paint.fillStyle = color;
      paint.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = ([r, g, b, a]: Rgba, [R, G, B]: Rgba): Rgba => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];
    // The colour a box shows: its own background over those behind it.
    const background = (e: Element | null): Rgba => {
      if (!e) return [255, 255, 255, 1];
      const own = rgba(getComputedStyle(e).backgroundColor);
      return own[3] >= 0.99 ? own : over(own, background(e.parentElement));
    };
    interface Look { outline: string; outlineColor: Rgba; shadow: string; background: Rgba; border: Rgba; text: Rgba; decoration: string }
    // How to take focus off the element without closing what it is in: a menu or picker closes when its
    // item loses focus, so its item gives focus to the list itself, or to an item two or more rows away.
    const restOf = async (target: HTMLElement) => {
      // A list that holds the focus itself (a combobox's list in a bottom sheet, its option shown by
      // aria-activedescendant) cannot hand it on without closing: what rests is its own focus ring.
      if (target.matches('[role="menu"], [role="listbox"]')) return async () => target.style.setProperty("outline", "none", "important");
      const list = target.closest<HTMLElement>('[role="menu"], [role="listbox"]');
      if (!list) return async () => target.blur();
      const items = Array.from(list.querySelectorAll<HTMLElement>(`[role="${target.getAttribute("role")}"]`));
      const far = items.find((item) => Math.abs(items.indexOf(item) - items.indexOf(target)) >= 2) ?? items.find((item) => item !== target);
      return async () => {
        list.focus({ preventScroll: true });
        if (document.activeElement === target) far?.focus({ preventScroll: true });
      };
    };
    // How the element and its near ancestors look once their colour transitions end.
    const look = async (from: HTMLElement): Promise<Look[]> => {
      const chain: HTMLElement[] = [];
      for (let e: HTMLElement | null = from, i = 0; e && e !== document.body && i < 5; e = e.parentElement, i++) chain.push(e);
      const moving = chain.flatMap((e) => e.getAnimations()).filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
      await Promise.all(moving.map((a) => a.finished.catch(() => undefined)));
      return chain.map((e) => {
        const s = getComputedStyle(e);
        const outlineColor = rgba(s.outlineColor);
        const visibleOutline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 && outlineColor[3] > 0;
        return {
          outline: visibleOutline ? `${s.outlineStyle} ${s.outlineWidth} ${s.outlineOffset}` : "none",
          outlineColor: over(outlineColor, background(e)),
          shadow: s.boxShadow === "none" || !/rgba?\((?![^)]*,\s*0\))/.test(s.boxShadow) ? "none" : s.boxShadow,
          background: background(e),
          border: over(rgba(s.borderTopColor), background(e)),
          text: over(rgba(s.color), background(e)),
          decoration: s.textDecorationLine,
        };
      });
    };
    const focusVisible = el.matches(":focus-visible");
    const chain: HTMLElement[] = [];
    for (let e: HTMLElement | null = el, i = 0; e && e !== document.body && i < 5; e = e.parentElement, i++) chain.push(e);
    const focused = await look(el);
    (window as unknown as { a11yRest: () => Promise<void> }).a11yRest = await restOf(el);
    await (window as unknown as { a11yRest: () => Promise<void> }).a11yRest();
    const resting = await look(el);
    el.style.removeProperty("outline");
    el.focus({ preventScroll: true });
    // The indicator's owner: the outermost of the element and its near ancestors whose look changes with
    // focus (a card's ring for its radio, a field group's edge for its input). The screenshots measure it.
    const owner = chain.findLast((_, i) => resting[i] && JSON.stringify(focused[i]) !== JSON.stringify(resting[i]));
    // Marked, so the screenshots read where it is when they are taken (focusStop).
    document.querySelectorAll("[data-a11y-owner]").forEach((e) => e.removeAttribute("data-a11y-owner"));
    owner?.setAttribute("data-a11y-owner", "");
    const box = owner?.getBoundingClientRect();

    const r = el.getBoundingClientRect();
    const x0 = Math.max(r.left, 0), x1 = Math.min(r.right, innerWidth);
    const y0 = Math.max(r.top, 0), y1 = Math.min(r.bottom, innerHeight);
    const pinnedBox = (e: Element | null) => {
      for (let p = e; p && p !== document.body; p = p.parentElement) {
        const pos = getComputedStyle(p).position;
        if (pos === "fixed" || pos === "sticky") return p;
      }
      return null;
    };
    const ownPin = pinnedBox(el);
    const padding = getComputedStyle(document.documentElement);
    const room = innerHeight - (Number.parseFloat(padding.scrollPaddingTop) || 0) - (Number.parseFloat(padding.scrollPaddingBottom) || 0);
    let covered = 0, byPinned = 0, byPinnedAtTop = 0, points = 0;
    let coveredBy: string | null = null;
    if (x1 > x0 && y1 > y0) {
      for (const fx of [0.1, 0.5, 0.9]) {
        for (const fy of [0.1, 0.5, 0.9]) {
          points++;
          const top = document.elementFromPoint(x0 + (x1 - x0) * fx, y0 + (y1 - y0) * fy);
          if (!top || el.contains(top) || top.contains(el)) continue;
          covered++;
          const pin = pinnedBox(top);
          if (pin && pin !== ownPin && !pin.contains(el)) {
            byPinned++;
            if (fy === 0.1) byPinnedAtTop++;
          }
          const cover = pin ?? top;
          coveredBy ??= `${cover.tagName.toLowerCase()}.${String(cover.className).split(" ").slice(0, 4).join(".")}`;
        }
      }
    }
    let scrolled = scrollY;
    for (let p = el.parentElement; p; p = p.parentElement) scrolled += p.scrollTop;
    const onScreenEdges = (box: DOMRect) => {
      const wide = Math.max(0, Math.min(box.right, innerWidth) - Math.max(box.left, 0));
      const high = Math.max(0, Math.min(box.bottom, innerHeight) - Math.max(box.top, 0));
      const edges = (box.top >= 0 ? wide : 0) + (box.bottom <= innerHeight ? wide : 0) + (box.left >= 0 ? high : 0) + (box.right <= innerWidth ? high : 0);
      return edges > 0 ? edges : 2 * (wide + high);
    };
    const name = el.getAttribute("aria-label") ?? (el as HTMLInputElement).labels?.[0]?.textContent ?? el.getAttribute("title") ?? el.textContent ?? "";
    return {
      key: el.dataset.a11yStop!,
      label: `${el.getAttribute("role") ?? el.tagName.toLowerCase()} "${name.trim().replace(/\s+/g, " ").slice(0, 60)}"`,
      indicator: false,
      owner: box ? { x: box.left, y: box.top, width: box.width, height: box.height } : null,
      // A one-pixel line along the element's edges that are on screen, in CSS px²: an edge past the window's is no ring's
      // to draw (a region taller than the window, scrolled to show its top). With no edge on screen, a line around all
      // of what shows: the indicator must then be inside it.
      perimeter: onScreenEdges(r),
      focusVisible,
      // A region taller than the room the page's scroll padding leaves for its docked bars (a transcript under a docked
      // player and a docked decision) is one lib/dock.ts scrolls nowhere: it shows a part of itself whatever is pinned,
      // and a bar over its lower part hides no more than the window's edge does. Its top, where its ring and name
      // start, must still be clear. Only a region: a control (a field, a button, a passage's [role=button]) is held to
      // the bar whatever its height.
      obscured: (points > 0 && covered === points
        ? "full"
        : byPinned > 0 && !(r.height > room && byPinnedAtTop === 0 && el.matches('[role="region"], section'))
          ? "partial"
          : "none") as FocusStop["obscured"],
      coveredBy,
      offscreen: points === 0,
      pinned: ownPin !== null,
      // A native <dialog> (the design system's) carries no role attribute.
      inDialog: el.closest('dialog, [role="dialog"], [role="alertdialog"]') !== null,
      container: el.parentElement?.closest<HTMLElement>("[data-a11y-stop]")?.dataset.a11yStop ?? null,
      top: Math.round(r.top + scrolled),
      bottom: Math.round(r.bottom + scrolled),
      left: Math.round(r.left),
      right: Math.round(r.right),
    };
  });
}

/**
 * Tabs from the top of the page until focus leaves the document, which is
 * where a page's tab order ends. Coming back to a control already passed
 * without leaving first is a trap (WCAG 2.1.2), as is `max` stops.
 */
export async function tabWalk(page: Page, max = 90) {
  // In Chromium Tab goes on from a page's last control to the browser's own, and the document loses the focus: that is
  // the end. A browser without a window need not have such controls: Firefox then keeps the focus where it is, as a trap
  // would, and what WebKit does is its build's. So outside Chromium a stop of the walk's own after the page's last one
  // stands in for them: reaching it is leaving the page, and a trap never reaches it.
  const closed = engine(page) !== "chromium";
  await page.evaluate((closed) => {
    const start = document.createElement("span");
    start.tabIndex = -1;
    start.id = "a11y-walk-start";
    document.body.prepend(start);
    start.focus();
    if (!closed) return;
    const end = document.createElement("span");
    end.tabIndex = 0;
    end.id = "a11y-walk-end";
    // Out of the page's flow, so that it moves nothing.
    end.style.position = "fixed";
    document.body.append(end);
  }, closed);
  const stops: FocusStop[] = [];
  let left = false;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(tabKey(page));
    if (i === 0) await page.evaluate(() => document.getElementById("a11y-walk-start")?.remove());
    if (closed && (await page.evaluate(() => document.activeElement?.id === "a11y-walk-end"))) {
      left = true;
      break;
    }
    const stop = await focusStop(page);
    if (!stop) {
      left = true;
      break;
    }
    // Focus that stays, or comes round again, without leaving the document is held.
    if (stops.some((seen) => seen.key === stop.key)) break;
    stops.push(stop);
  }
  if (closed) await page.evaluate(() => document.getElementById("a11y-walk-end")?.remove());
  return { stops, left };
}

/** What is wrong with each stop: WCAG 2.4.7 and 2.4.11, and the house bar of no pinned bar over focus. */
export function stopProblems(stops: FocusStop[]): string[] {
  return stops.flatMap((s) => [
    ...(s.indicator ? [] : [s.unsettled ? `${s.label}: kept moving while its focus indicator was measured` : `${s.label}: no visible focus indicator (2.4.7)`]),
    ...(s.offscreen ? [`${s.label}: focused outside the viewport`] : []),
    ...(s.obscured === "full" ? [`${s.label}: entirely hidden by ${s.coveredBy} (2.4.11)`] : []),
    ...(s.obscured === "partial" ? [`${s.label}: partly under ${s.coveredBy} (house bar)`] : []),
  ]);
}

/**
 * Phones read top to bottom: a stop wholly above the one before it, in the
 * same column, is out of order (pinned bars and dialogs aside).
 */
export function orderProblems(stops: FocusStop[]): string[] {
  const flow = stops.filter((s) => !s.pinned && !s.inDialog);
  return flow.slice(1).flatMap((s, i) => {
    const before = flow[i];
    const sameColumn = s.left < before.right && s.right > before.left;
    return sameColumn && s.container !== before.key && s.bottom <= before.top ? [`${s.label} comes after ${before.label} but sits above it`] : [];
  });
}

/**
 * The name of the scrolling or clipping ancestor that cuts the focus ring of the focused element, if there is one:
 * the ring is drawn outside its owner (the element, or the near ancestor that carries the outline: a field's box)
 * by the outline's width and offset, and an ancestor that clips at the owner's own edge leaves a ring with a side
 * missing (WCAG 2.4.7).
 */
export function clippedFocus(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    let owner: HTMLElement = el;
    let ring = 0;
    for (let e: HTMLElement | null = el, i = 0; e && e !== document.body && i < 4; e = e.parentElement, i++) {
      const s = getComputedStyle(e);
      if (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) {
        owner = e;
        ring = parseFloat(s.outlineWidth) + Math.max(0, parseFloat(s.outlineOffset) || 0);
        break;
      }
    }
    const r = owner.getBoundingClientRect();
    for (let p = owner.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (!/auto|scroll|hidden|clip/.test(s.overflowX + s.overflowY)) continue;
      const b = p.getBoundingClientRect();
      if (r.left - ring < b.left || r.right + ring > b.right || r.top - ring < b.top || r.bottom + ring > b.bottom) {
        return `${p.tagName.toLowerCase()}.${String(p.className).split(" ")[0]}`;
      }
    }
    return null;
  });
}

/**
 * What a hand-copied quote of the transcript holds: the passages from the first to the one with a corrected word,
 * selected as a mouse drag selects them, read as the clipboard gets them.
 */
export const passagesQuote = (page: Page) =>
  page.evaluate(() => {
    const passages = [...document.querySelectorAll("[data-turn-index]")];
    const corrected = passages.find((passage) => passage.querySelector("[data-correction-note]"))!;
    const range = document.createRange();
    range.setStartBefore(passages[0]);
    range.setEndAfter(corrected);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
