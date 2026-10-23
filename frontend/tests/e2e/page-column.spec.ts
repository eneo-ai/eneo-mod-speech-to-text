/**
 * The page's column: what a page says starts where the bar's brand does, at every width, so the bar and the page share
 * one left edge, and the account ends where the column does (styles/globals.css aligns the bar to the column).
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

test("the account button ends where the page's column does", async ({ page }) => {
  for (const [width, height] of [
    [1366, 768],
    [1440, 900],
    [3440, 1440],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    const account = page.getByRole("button", { name: /^Öppna konto för/ });
    await expect(account).toBeVisible();
    const accountBox = (await account.boundingBox())!;
    // The column is --module-page-width wide and centred in the window.
    const columnEnd = await page.evaluate(() => {
      const probe = Object.assign(document.createElement("div"), { style: "width: var(--module-page-width)" });
      document.body.append(probe);
      const column = probe.getBoundingClientRect().width;
      probe.remove();
      return (document.documentElement.clientWidth + column) / 2;
    });
    expect(Math.abs(accountBox.x + accountBox.width - columnEnd), `at ${width} px, the account under the column's end`).toBeLessThanOrEqual(3);
  }
});

/** How wide a paragraph is in its own font's "0"s: a line of 55ch holds about 75 characters of Figtree. */
const measure = (paragraph: import("@playwright/test").Locator) =>
  paragraph.evaluate((p) => {
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(10);
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
    p.append(probe);
    const ch = probe.getBoundingClientRect().width / 10;
    probe.remove();
    return Math.round(p.getBoundingClientRect().width / ch);
  });

for (const [state, width, words] of [
  ["setup", 820, /^Inspelningen sparas/],
  ["setup", 1440, /^Inspelningen sparas/],
  ["ready", 1440, /skickar inspelningen till Eneo/],
  ["setup-speakers-blocked", 1440, /^Flödet behöver/],
] as const) {
  test(`a note across a wide card keeps a reading measure: ${state} at ${width} px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const { STATES } = await import("./screens");
    await STATES.find((s) => s.name === state)!.go(page, info);
    const paragraph = page.getByRole("main").locator("p").filter({ hasText: words }).first();
    await expect(paragraph).toBeVisible();
    expect(await measure(paragraph), "the paragraph's width in ch (data-measure is 55)").toBeLessThanOrEqual(56);
  });
}
