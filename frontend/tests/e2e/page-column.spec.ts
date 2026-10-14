/**
 * The page's column: what a page says starts where the bar's brand does, at every width, so the bar and the page share
 * one left edge (styles/globals.css aligns the bar to the column).
 */
import { expect, test } from "./gate";

test.beforeEach(({}, info) => test.skip(info.project.name !== "laptop-1440-light", "the widths are set here"));

test("a page that cannot be shown stands in the page's column: its heading starts where the brand does", async ({ page }) => {
  for (const [width, height] of [
    [1366, 768],
    [2560, 1440],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto("/finns-inte");
    const heading = page.getByRole("heading", { level: 1, name: "Sidan finns inte." });
    const brand = page.getByRole("banner").getByRole("img").first();
    await expect(heading).toBeVisible();
    const [headingBox, brandBox] = [await heading.boundingBox(), await brand.boundingBox()];
    expect(Math.abs(headingBox!.x - brandBox!.x), `at ${width} px, the heading under the brand`).toBeLessThanOrEqual(1);
  }
});
