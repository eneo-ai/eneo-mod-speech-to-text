/**
 * The reader's own text size: iOS's accessibility sizes set the page's root at 34 px (200 %) up to 53 px, and a phone's
 * 200 % page zoom leaves a 412 px phone 206 CSS px (WCAG 1.4.4, resize text to 200 % without loss of content). What
 * the design system keeps on one line, or at a fixed height, must give way there: nothing is cut off, and no control
 * is drawn over another's words.
 */
import { type Locator, type Page } from "@playwright/test";
import { expect, test } from "./gate";
import { addStyles } from "./checks";
import { mutedMicrophone, record, scrollWhilePlaying, setup, STATES } from "./screens";

type Size = { width: number; height: number; root: number };
const AX2: Size = { width: 390, height: 844, root: 34 };
const AX5: Size = { width: 390, height: 844, root: 53 };
const ZOOM: Size = { width: 206, height: 395, root: 16 };
const name = ({ width, root }: Size) => `${width} px, ${root} px text`;

test.beforeEach(({}, info) => test.skip(info.project.name !== "phone-390-light", "the window's size and text are set here"));

async function at(page: Page, state: string, { width, height, root }: Size) {
  await page.setViewportSize({ width, height });
  await STATES.find((s) => s.name === state)!.go(page, test.info());
  await addStyles(page, `html { font-size: ${root}px !important; }`);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/**
 * The words inside `scope` that their own box cuts off (one line with an ellipsis, a fixed height), as "text sw/cw".
 * `heightOnly` for a value a selector keeps on one line by design (its list has it whole): only its lines may not be cut.
 */
function cut(scope: Locator, heightOnly = false) {
  return scope.evaluate((root, heightOnly) => {
    const found: string[] = [];
    for (const element of [root, ...root.querySelectorAll("*")]) {
      if (!(element instanceof HTMLElement) || element.closest(".astryx-visually-hidden") || !element.textContent?.trim()) continue;
      const style = getComputedStyle(element);
      // A box of no size is not drawn (a design system's copy of a label in bold, kept for its width).
      if (style.display === "none" || element.clientWidth <= 1 || element.clientHeight === 0) continue;
      const x = !heightOnly && ["hidden", "clip"].includes(style.overflowX) && element.scrollWidth > element.clientWidth + 1;
      const y = ["hidden", "clip"].includes(style.overflowY) && element.scrollHeight > element.clientHeight + 2;
      if (x || y) found.push(`${element.textContent.trim().slice(0, 30)} ${element.scrollWidth}x${element.scrollHeight}/${element.clientWidth}x${element.clientHeight}`);
    }
    return found;
  }, heightOnly);
}

for (const size of [AX2, AX5, ZOOM]) {
  test(`earlier runs keep their date and state whole at ${name(size)}`, async ({ page }) => {
    await at(page, "setup", size);
    const runs = page.getByRole("region", { name: "Tidigare körningar" });
    await expect(runs.getByRole("button", { name: /^Öppna, körningen/ }).first()).toBeVisible();
    expect(await cut(runs)).toEqual([]);
  });
}

for (const size of [AX5, ZOOM]) {
  test(`the transcript's speaker filter keeps its words at ${name(size)}`, async ({ page }) => {
    await at(page, "result-transcript-tab", size);
    const filter = page.getByRole("combobox", { name: "Talare" });
    await expect(filter).toBeVisible();
    expect((await filter.boundingBox())!.width, "the filter is not squeezed to nothing").toBeGreaterThanOrEqual(80);
    expect(await cut(filter)).toEqual([]);
  });
}

/**
 * Brought into view, `element` is wholly in the window and nothing is drawn over it: what large text makes too tall to pin
 * scrolls with the page instead of covering it.
 */
const uncovered = (element: Locator) =>
  element.evaluate((el) => {
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    if (r.top < -0.5 || r.bottom > innerHeight + 0.5) return `outside the window (${Math.round(r.top)}-${Math.round(r.bottom)} of ${innerHeight})`;
    for (const y of [r.top + 2, r.top + r.height / 2, r.bottom - 2]) {
      const top = document.elementFromPoint(r.left + r.width / 2, y);
      if (top && !(el === top || el.contains(top) || top.contains(el))) return `covered at ${Math.round(y)} by ${top.tagName}.${String(top.className).slice(0, 40)}`;
    }
    return null;
  });

const RECORDING: [size: Size, what: string][] = [
  // An iPhone in Safari at iOS's 194 % text: 664 px of window under the address bar.
  [{ width: 390, height: 664, root: 34 }, "the warning"],
  [AX5, "the warning"],
  // An iPad upright at iOS's largest text: the bar outgrew its window and covered the timer.
  [{ width: 834, height: 1031, root: 53 }, "the timer"],
];
for (const [size, what] of RECORDING) {
  test(`a recording at ${size.width} x ${size.height}, ${size.root} px text: ${what} can be read and Stoppa stays on the screen`, async ({ page }) => {
    await page.addInitScript(mutedMicrophone);
    await page.setViewportSize({ width: size.width, height: size.height });
    await setup(page);
    await addStyles(page, `html { font-size: ${size.root}px !important; }`);
    await record(page, "Spela in");
    const warning = page.getByRole("alert").filter({ hasText: "Vi hör inget från mikrofonen." });
    await expect(warning).toBeVisible({ timeout: 15_000 });
    const timer = page.locator("section[aria-label='Ljudet'] *").filter({ hasText: /^\d+:\d\d$/ }).first();
    expect(await uncovered(what === "the warning" ? warning : timer), what).toBeNull();
    expect(await uncovered(page.getByRole("button", { name: "Stoppa" })), "Stoppa").toBeNull();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "nothing past the window's side").toBe(true);
    const stoppa = (await page.getByRole("button", { name: "Stoppa" }).boundingBox())!;
    expect(stoppa.x + stoppa.width, "Stoppa within the window").toBeLessThanOrEqual(size.width);
  });
}

/** The buttons and links in `scope` whose icon is drawn over their own words, by name. */
function iconsOverWords(scope: Locator) {
  return scope.evaluate((root) => {
    const found: string[] = [];
    for (const control of root.querySelectorAll("button, a")) {
      const icon = control.querySelector("svg")?.getBoundingClientRect();
      if (!icon || icon.width === 0) continue;
      const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim() || node.parentElement?.closest(".astryx-visually-hidden")) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const line of range.getClientRects()) {
          const x = Math.min(icon.right, line.right) - Math.max(icon.left, line.left);
          const y = Math.min(icon.bottom, line.bottom) - Math.max(icon.top, line.top);
          if (x > 1 && y > 1) found.push(control.getAttribute("aria-label") ?? control.textContent!.trim());
        }
      }
    }
    return [...new Set(found)];
  });
}

for (const size of [AX2, AX5]) {
  test(`the microphone's picker and its test keep their words whole at ${name(size)}`, async ({ page }) => {
    await at(page, "setup-microphone-check", size);
    const section = page.getByRole("button", { name: "Sluta testa" }).locator("xpath=ancestor::section[1]");
    expect(await cut(page.getByRole("combobox", { name: "Mikrofon" }), true)).toEqual([]);
    expect(await cut(page.getByRole("button", { name: "Sluta testa" }))).toEqual([]);
    expect(await iconsOverWords(section)).toEqual([]);
  });

  test(`a button's icon stands beside its words at ${name(size)}`, async ({ page }) => {
    await at(page, "result", size);
    expect(await iconsOverWords(page.locator("[role=main]"))).toEqual([]);
  });
}

for (const size of [AX5, ZOOM, { width: 834, height: 1031, root: 53 }]) {
  test(`a flow's bar keeps its way back and the account apart at ${name(size)}`, async ({ page }) => {
    await at(page, "setup", size);
    const back = page.getByRole("link", { name: "Alla flöden" });
    const account = page.getByRole("button", { name: /Öppna konto för/ });
    const [backBox, accountBox] = [(await back.boundingBox())!, (await account.boundingBox())!];
    expect(accountBox.x - (backBox.x + backBox.width), "the room between them").toBeGreaterThanOrEqual(0);
    expect(await cut(page.getByRole("banner"))).toEqual([]);
    expect(await page.getByRole("banner").evaluate((bar) => bar.scrollWidth <= bar.clientWidth), "nothing past the bar's edge").toBe(true);
  });
}

for (const size of [AX5, ZOOM]) {
  test(`"Följ uppspelningen" stays inside the player at ${name(size)}`, async ({ page }) => {
    await at(page, "result-transcript-tab", size);
    // Scrolling the text by hand while it plays stops following the playhead, and the player offers to follow it again.
    const follow = await scrollWhilePlaying(page);
    const [box, dock] = [(await follow.boundingBox())!, (await page.locator("[data-docked-player]", { has: follow }).boundingBox())!];
    expect(box.x, "not past the player's start").toBeGreaterThanOrEqual(dock.x - 0.5);
    expect(box.x + box.width, "not past the player's end").toBeLessThanOrEqual(dock.x + dock.width + 0.5);
    expect(await cut(follow)).toEqual([]);
  });
}

for (const size of [AX2, AX5, ZOOM]) {
  test(`a pill, the result's tabs and its details keep their words at ${name(size)}`, async ({ page }) => {
    await at(page, "review", size);
    expect(await cut(page.getByText("Osäkert förslag").first().locator(".."))).toEqual([]);
    await at(page, "result", size);
    const tabs = page.getByRole("tablist");
    expect(await tabs.evaluate((strip) => strip.scrollWidth <= strip.clientWidth + 1), "both tabs in view, no strip to scroll").toBe(true);
    expect(await cut(tabs)).toEqual([]);
    expect(await cut(page.getByText(/^Deltagare:/))).toEqual([]);
  });
}

for (const size of [AX2, AX5]) {
  test(`a speaker's letter stays inside its round mark at ${name(size)}`, async ({ page }) => {
    await at(page, "review", size);
    const outside = await page.locator("span[aria-hidden][data-size]").evaluateAll((marks) =>
      marks.flatMap((mark) => {
        const disc = mark.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(mark);
        const letter = range.getBoundingClientRect();
        return letter.left < disc.left - 0.5 || letter.right > disc.right + 0.5 || letter.top < disc.top - 0.5 || letter.bottom > disc.bottom + 0.5
          ? [`${mark.textContent} ${Math.round(letter.width)}x${Math.round(letter.height)} in ${Math.round(disc.width)}x${Math.round(disc.height)}`]
          : [];
      }),
    );
    expect(outside).toEqual([]);
  });
}

test("an iPad upright at the largest text: the speaker chips stand clear of the search under them", async ({ page }) => {
  await at(page, "result-transcript-tab", { width: 834, height: 1031, root: 53 });
  const chips = await page.locator(".astryx-toggle-button").evaluateAll((buttons) => buttons.map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0).map((r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right })));
  const field = await page.getByRole("textbox", { name: "Sök i transkriberingen" }).evaluate((input) => {
    const r = (input.closest(".astryx-text-input") ?? input).getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
  expect(chips.length, "the chips are shown").toBeGreaterThan(0);
  const over = chips.filter((c) => Math.min(c.bottom, field.bottom) - Math.max(c.top, field.top) > 1 && Math.min(c.right, field.right) - Math.max(c.left, field.left) > 1);
  expect(over, "no chip over the search field").toEqual([]);
  expect(await cut(page.locator(".astryx-toggle-button").first())).toEqual([]);
});

for (const size of [AX2, AX5]) {
  test(`a flow's description in the list is whole at ${name(size)}`, async ({ page }) => {
    await at(page, "flow-list", size);
    const row = page.getByRole("link", { name: /^Nämndmöte till rapport/ }).locator("xpath=ancestor::li[1]");
    expect(await cut(row)).toEqual([]);
  });
}

test(`a field's "Valfritt" stays inside the card at ${name(AX5)}`, async ({ page }) => {
  await at(page, "setup", AX5);
  const past = await page.locator(".astryx-field-label").evaluateAll((labels) =>
    labels.filter((label) => label.getBoundingClientRect().width > 1).flatMap((label) => [...label.querySelectorAll("*")].filter((part) => part.getBoundingClientRect().right > label.getBoundingClientRect().right + 0.5).map((part) => part.textContent!.trim())),
  );
  expect(past).toEqual([]);
});
