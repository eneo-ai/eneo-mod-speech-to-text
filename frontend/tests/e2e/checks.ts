/**
 * The gate's measurements, each run in the page: axe, target sizes, reflow,
 * motion, and where keyboard focus lands. Each returns data; the specs decide
 * what fails.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";

export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

/** Waits for opening animations (a dialog fading in) and colour transitions to end, so colours are measured at rest. */
export async function settle(page: Page) {
  // Animations and transitions both: a colour fading to its end would be measured halfway.
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity),
  );
}

export async function axe(page: Page) {
  await settle(page);
  const result = await new AxeBuilder({ page }).withTags(WCAG_TAGS).exclude("nextjs-portal").analyze();
  return {
    violations: result.violations.map((v) => ({
      id: v.id,
      impact: v.impact ?? null,
      tags: v.tags,
      help: v.help,
      nodes: v.nodes.map((n) => ({ target: n.target.join(" "), summary: n.failureSummary ?? "" })),
    })),
    incomplete: result.incomplete.map((v) => ({ id: v.id, help: v.help, nodes: v.nodes.length })),
  };
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
        'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], [role="combobox"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="option"]';
      type Box = { left: number; top: number; right: number; bottom: number };
      const box = (r: DOMRect | Box): Box => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      const shown = (el: Element) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && Number(s.opacity) > 0 && !el.closest('[aria-hidden="true"], [inert], [hidden]');
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
        const labels = (el as HTMLInputElement).labels;
        if (labels) for (const label of Array.from(labels)) out.push(box(label.getBoundingClientRect()));
        if (el.getAttribute("role") === "slider") {
          const track = el.parentElement?.closest("[data-orientation]");
          if (track) out.push(box(track.getBoundingClientRect()));
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

/** Controls without a name in Chromium's own accessibility tree, the one screen readers get (WCAG 4.1.2). */
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

/** The role, name and description Chromium's own tree gives one element, the ones a screen reader reads. */
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
      nodes: { role?: { value: string }; name?: { value: string }; description?: { value: string } }[];
    };
    const [node] = nodes;
    return { role: node.role?.value ?? "", name: node.name?.value ?? "", description: node.description?.value ?? "" };
  } finally {
    await cdp.detach();
    await locator.evaluate((element) => element.removeAttribute("data-ax-probe"));
  }
}

/** WCAG 1.4.10: no horizontal scroll, nothing past the right edge, nothing cut off; ellipsis is listed apart. */
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
      if (r.width < 2 || r.height < 2 || s.visibility === "hidden" || el.closest('[aria-hidden="true"], nextjs-portal')) continue;
      // Visually hidden text for screen readers is meant to be clipped.
      if (s.position === "absolute" && (s.clip !== "auto" || r.width <= 1)) continue;
      const scrollsX = (e: Element | null): boolean =>
        !!e && e !== document.body && (["auto", "scroll"].includes(getComputedStyle(e).overflowX) || scrollsX(e.parentElement));
      const text = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
      if (r.right > width + 1 && (text || el.matches("button, a, input, select, textarea, img, svg")) && !scrollsX(el.parentElement)) {
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
}

/**
 * Where focus is now, or null when it left the page (the end of the tab order).
 * The focus indicator is measured as rendered: screenshots of the indicator's
 * owner (the outermost near box whose look changes) with and without focus, and
 * the pixels that change by 3:1 or more must add up to at least a one-pixel
 * line around the element. An outline the eye cannot see is no indicator.
 */
export async function focusStop(page: Page): Promise<FocusStop | null> {
  const stop = await probeFocus(page);
  if (!stop) return null;
  const { owner, perimeter, ...rest } = stop;
  const area = owner === null ? 0 : await seenChange(page, owner);
  return { ...rest, indicator: area >= perimeter, indicatorArea: Math.round(area), perimeter: Math.round(perimeter) };
}

export type Rect = { x: number; y: number; width: number; height: number };

/** How much of the owner's rendering focus changes by 3:1 or more, in CSS px². */
async function seenChange(page: Page, box: Rect): Promise<number> {
  const clip = await screenClip(page, box);
  if (!clip) return 0;
  const withFocus = await shot(page, clip);
  await page.evaluate(() => (window as unknown as { a11yRest: () => Promise<void> }).a11yRest());
  const without = await shot(page, clip);
  await page.evaluate(() => (document.querySelector("[data-a11y-current]") as HTMLElement | null)?.focus({ preventScroll: true }));
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
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
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
    if (el.closest("nextjs-portal")) return null;
    el.dataset.a11yStop ??= String(Math.random()).slice(2);
    document.querySelectorAll("[data-a11y-current]").forEach((e) => e.removeAttribute("data-a11y-current"));
    el.setAttribute("data-a11y-current", "");
    type Rgba = [number, number, number, number];
    const rgba = (color: string): Rgba => {
      const n = (color.match(/[\d.]+/g) ?? []).map(Number);
      return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 1];
    };
    const over = ([r, g, b, a]: Rgba, [R, G, B]: Rgba): Rgba => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];
    const luminance = ([r, g, b]: Rgba) =>
      [r, g, b].map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const contrast = (a: Rgba, b: Rgba) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
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
    el.focus({ preventScroll: true });
    // The indicator's owner: the outermost of the element and its near ancestors whose look changes with
    // focus (a card's ring for its radio, a field group's edge for its input). The screenshots measure it.
    const owner = chain.findLast((_, i) => resting[i] && JSON.stringify(focused[i]) !== JSON.stringify(resting[i]));
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
    let covered = 0, byPinned = 0, points = 0;
    let coveredBy: string | null = null;
    if (x1 > x0 && y1 > y0) {
      for (const fx of [0.1, 0.5, 0.9]) {
        for (const fy of [0.1, 0.5, 0.9]) {
          points++;
          const top = document.elementFromPoint(x0 + (x1 - x0) * fx, y0 + (y1 - y0) * fy);
          if (!top || el.contains(top) || top.contains(el)) continue;
          covered++;
          const pin = pinnedBox(top);
          if (pin && pin !== ownPin && !pin.contains(el)) byPinned++;
          const cover = pin ?? top;
          coveredBy ??= `${cover.tagName.toLowerCase()}.${String(cover.className).split(" ").slice(0, 4).join(".")}`;
        }
      }
    }
    let scrolled = scrollY;
    for (let p = el.parentElement; p; p = p.parentElement) scrolled += p.scrollTop;
    const name = el.getAttribute("aria-label") ?? (el as HTMLInputElement).labels?.[0]?.textContent ?? el.getAttribute("title") ?? el.textContent ?? "";
    return {
      key: el.dataset.a11yStop!,
      label: `${el.getAttribute("role") ?? el.tagName.toLowerCase()} "${name.trim().replace(/\s+/g, " ").slice(0, 60)}"`,
      indicator: false,
      owner: box ? { x: box.left, y: box.top, width: box.width, height: box.height } : null,
      // A one-pixel line around the element, in CSS px².
      perimeter: 2 * (Math.min(r.width, innerWidth) + Math.min(r.height, innerHeight)),
      focusVisible,
      obscured: (points > 0 && covered === points ? "full" : byPinned > 0 ? "partial" : "none") as FocusStop["obscured"],
      coveredBy,
      offscreen: points === 0,
      pinned: ownPin !== null,
      inDialog: el.closest('[role="dialog"], [role="alertdialog"]') !== null,
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
  await page.evaluate(() => {
    const start = document.createElement("span");
    start.tabIndex = -1;
    start.id = "a11y-walk-start";
    document.body.prepend(start);
    start.focus();
  });
  const stops: FocusStop[] = [];
  let left = false;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    if (i === 0) await page.evaluate(() => document.getElementById("a11y-walk-start")?.remove());
    const stop = await focusStop(page);
    if (!stop) {
      left = true;
      break;
    }
    // Focus that stays, or comes round again, without leaving the document is held.
    if (stops.some((seen) => seen.key === stop.key)) break;
    stops.push(stop);
  }
  return { stops, left };
}

/** What is wrong with each stop: WCAG 2.4.7 and 2.4.11, and the house bar of no pinned bar over focus. */
export function stopProblems(stops: FocusStop[]): string[] {
  return stops.flatMap((s) => [
    ...(s.indicator ? [] : [`${s.label}: no visible focus indicator (2.4.7)`]),
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
