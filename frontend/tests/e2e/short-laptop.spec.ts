/**
 * A short laptop (1280 × 720, 1366 × 768): the transcript's card keeps to the window from a laptop's width, its text
 * scrolling inside it and the player at its end, and it ends in the window before the page is scrolled, so the player
 * is in view at once. The result's card and the review's.
 */
import { type Locator, type Page, type TestInfo } from "@playwright/test";
import { expect, test } from "./gate";
import { result, STATES } from "./screens";

test.beforeEach(({}, info) => test.skip(info.project.name !== "laptop-1280-light", "the window's sizes are set here"));

const VIEWS: { name: string; go: (page: Page, info: TestInfo) => Promise<unknown>; card: (page: Page) => Locator }[] = [
  { name: "the result", go: (page) => result(page), card: (page) => page.getByRole("region", { name: "Transkribering", exact: true }) },
  {
    name: "the review",
    go: (page, info) => STATES.find((state) => state.name === "review")!.go(page, info),
    card: (page) => page.getByRole("region", { name: "Inspelning och transkribering" }),
  },
];

for (const view of VIEWS) {
  test(`${view.name}: the transcript's card, its player last, ends in the window before the page is scrolled`, async ({ page }, info) => {
    for (const [width, height] of [
      [1280, 720],
      [1366, 768],
    ]) {
      await page.setViewportSize({ width, height });
      await view.go(page, info);
      const card = view.card(page);
      await expect(page.getByRole("group", { name: /^Uppspelning/ }).first()).toBeVisible();
      expect(await page.evaluate(() => window.scrollY), "the page as it opens").toBe(0);
      const box = (await card.boundingBox())!;
      expect(Math.round(box.y + box.height), `at ${width} × ${height}, the card's end`).toBeLessThanOrEqual(height);
    }
  });
}
