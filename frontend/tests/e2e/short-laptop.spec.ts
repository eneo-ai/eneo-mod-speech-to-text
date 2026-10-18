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

  test(`${view.name}: in a window lower than the player's own, the end of a long transcript is reached by scrolling the page`, async ({ page }, info) => {
    for (const [width, height] of [
      [1280, 480],
      [1024, 600],
    ]) {
      await page.setViewportSize({ width, height });
      await view.go(page, info);
      await expect(page.getByRole("group", { name: /^Uppspelning/ }).first()).toBeVisible();
      const card = view.card(page);
      // A long meeting: the transcript's passages, as the page drew them, thirty times over.
      const last = await card.evaluate((element) => {
        const passages = element.querySelector("[data-segment-index]")?.parentElement;
        if (!passages) throw new Error("no passages");
        for (const passage of [...passages.children].flatMap((child) => Array(30).fill(child))) {
          passages.appendChild(passage.cloneNode(true));
        }
        const all = element.querySelectorAll<HTMLElement>("[data-segment-index]");
        all[all.length - 1].dataset.last = "true";
        return all.length;
      });
      expect(last).toBeGreaterThan(30);
      // Only the page scrolls, as a wheel or a finger would: a card that clips can still be scrolled by a script.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const end = page.locator("[data-last]");
      const box = (await end.boundingBox())!;
      const shown = await end.evaluate((element) => {
        const { left, top, height: tall } = element.getBoundingClientRect();
        const hit = document.elementFromPoint(left + 4, top + tall / 2);
        return hit !== null && element.contains(hit);
      });
      expect(box.y + box.height, `at ${width} × ${height}, the last passage's end`).toBeLessThanOrEqual(height + 1);
      expect(shown, `at ${width} × ${height}, the last passage is not covered or cut off`).toBe(true);
    }
  });
}
