/**
 * The reader's own text size: iOS's accessibility sizes set the page's root at 34 px (200 %) up to 53 px, and a phone's
 * 200 % page zoom leaves a 412 px phone 206 CSS px (WCAG 1.4.4, resize text to 200 % without loss of content). What
 * the design system keeps on one line, or at a fixed height, must give way there: nothing is cut off, and no control
 * is drawn over another's words.
 */
import { type Locator, type Page } from "@playwright/test";
import { expect, test } from "./gate";
import { addStyles } from "./checks";
import { STATES } from "./screens";

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
