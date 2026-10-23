/**
 * Motion as the person asked for it: with reduced motion nothing turns or slides on the way to where it ends (a chevron
 * shows open or closed by its end position), and a scroll the page makes by itself over a long way jumps rather than
 * glides for a second and a half.
 */
import { expect, test } from "./gate";
import { isLaptop, run, STATES } from "./screens";
import ids from "../fixtures/ids.json";

/** Elements that would move on their way somewhere: a transition of their position, size or turn. */
const movingTransitions = () => {
  const moving: string[] = [];
  for (const element of document.querySelectorAll("*")) {
    const style = getComputedStyle(element);
    const properties = style.transitionProperty.split(",").map((p) => p.trim());
    const durations = style.transitionDuration.split(",").map((d) => Number.parseFloat(d));
    properties.forEach((property, i) => {
      const ms = (durations[i % durations.length] ?? 0) * (style.transitionDuration.includes("ms") ? 1 : 1000);
      if (ms > 0 && /^(all|transform|translate|scale|rotate)$/.test(property)) moving.push(`${element.tagName.toLowerCase()}.${String(element.getAttribute("class")).slice(0, 40)}: ${property}`);
    });
  }
  return [...new Set(moving)];
};

for (const state of ["result-steps-open", "failure", "foundation-selector"]) {
  test(`with reduced motion nothing in ${state} turns or slides on its way`, async ({ page }, info) => {
    test.skip(info.project.name !== "reduced-motion", "the person who asked for less motion");
    await STATES.find((s) => s.name === state)!.go(page, info);
    expect(await page.evaluate(movingTransitions)).toEqual([]);
  });
}

test("following the playhead to a passage far away jumps there, rather than gliding past thousands of pixels", async ({ page }, info) => {
  test.skip(!isLaptop(info) || info.project.name !== "laptop-1440-light", "the transcript scrolls in its own box on a laptop");
  await run(page, ids.runs.long);
  const box = page.locator("[data-turn-index]").first().locator("xpath=ancestor::div[contains(@class,'scrollport')][1]");
  await expect.poll(() => page.locator("[data-turn-index]").count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(1_500);
  // The recording plays from its start while the text is read at its far end: following it again goes two thousand
  // passages up.
  await page.locator("[data-docked-player]").getByRole("button", { name: "Spela upp" }).click();
  // A scroll the page made by itself a moment ago is not the person's: the wheel comes after it.
  await page.waitForTimeout(900);
  await box.evaluate((element) => element.scrollTo({ top: element.scrollHeight, behavior: "instant" }));
  await box.dispatchEvent("wheel");
  // A glide stops at the positions on the way, one a frame for up to 1.5 s; a jump lands with no stop between. Counted,
  // not timed: laying out two thousand passages on a slow runner takes its own time before either begins.
  await box.evaluate((element) => {
    const passed: number[] = [];
    (window as unknown as { passed: number[] }).passed = passed;
    element.addEventListener("scroll", () => element.scrollTop >= 2_000 && passed.push(element.scrollTop));
  });
  await page.getByRole("button", { name: "Följ uppspelningen" }).click({ timeout: 5_000 });
  await expect.poll(() => box.evaluate((element) => element.scrollTop), { timeout: 5_000, intervals: [20] }).toBeLessThan(2_000);
  const passed = await page.evaluate(() => (window as unknown as { passed: number[] }).passed);
  expect(passed, "there at once, not after a glide").toEqual([]);
});
