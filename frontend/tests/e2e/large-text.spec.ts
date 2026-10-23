/**
 * The reader's own text size: iOS's accessibility sizes set the page's root at 34 px (200 %) up to 53 px, and a phone's
 * 200 % page zoom leaves a 412 px phone 206 CSS px (WCAG 1.4.4, resize text to 200 % without loss of content). What
 * the design system keeps on one line, or at a fixed height, must give way there: nothing is cut off, and no control
 * is drawn over another's words.
 */
import { type Locator, type Page } from "@playwright/test";
import { expect, test } from "./gate";
import { addStyles } from "./checks";
import { mutedMicrophone, record, setup, STATES } from "./screens";

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

/** The words inside `scope` that their own box cuts off (one line with an ellipsis, a fixed height), as "text sw/cw". */
function cut(scope: Locator) {
  return scope.evaluate((root) => {
    const found: string[] = [];
    for (const element of [root, ...root.querySelectorAll("*")]) {
      if (!(element instanceof HTMLElement) || element.closest(".astryx-visually-hidden") || !element.textContent?.trim()) continue;
      const style = getComputedStyle(element);
      if (style.display === "none" || element.clientWidth <= 1) continue;
      const x = ["hidden", "clip"].includes(style.overflowX) && element.scrollWidth > element.clientWidth + 1;
      const y = ["hidden", "clip"].includes(style.overflowY) && element.scrollHeight > element.clientHeight + 2;
      if (x || y) found.push(`${element.textContent.trim().slice(0, 30)} ${element.scrollWidth}x${element.scrollHeight}/${element.clientWidth}x${element.clientHeight}`);
    }
    return found;
  });
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
