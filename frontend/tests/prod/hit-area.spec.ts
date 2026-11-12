/**
 * Under a finger, a pass of Astryx's hit areas reads the boxes of the page's interactive elements. In the built app it
 * reads only the rendered ones (lib/astryx-hit-area.mts): a long transcript's passages far from the window are not laid
 * out, and reading their thousands of buttons made one key in its search take seconds on a phone.
 */
import { expect } from "@playwright/test";
import { test } from "../e2e/auth";
import ids from "../fixtures/ids.json";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("a key in a long transcript's search reads the boxes of the passages near the window, not of all 2,000 @chromium", async ({ session, page }) => {
  expect(session.user).toBeTruthy();
  await page.goto(`/flows/${ids.flows.flow1}?run=${ids.runs.long}`);
  await expect(page.getByRole("heading", { name: /Dokumentet är klart/ })).toBeVisible();
  await page.getByRole("tab", { name: "Transkribering" }).click();
  const search = page.getByRole("textbox", { name: "Sök i transkriberingen" }).first();
  await expect(search).toBeVisible();
  expect(await page.locator("button").count(), "the transcript's buttons").toBeGreaterThan(5_000);
  type Counted = { reads: number; passed: boolean };
  await page.evaluate(() => {
    const read = Element.prototype.getBoundingClientRect;
    const counted = window as unknown as Counted;
    Object.assign(counted, { reads: 0, passed: false });
    Element.prototype.getBoundingClientRect = function (this: Element) {
      counted.reads++;
      // A pass reads the page first, then the box of the control it measures: the search's clear button, which the key
      // brings.
      if (this.getAttribute("aria-label")?.startsWith("Rensa")) counted.passed = true;
      return read.call(this);
    };
  });
  await search.press("b");
  await expect.poll(() => page.evaluate(() => (window as unknown as Counted).passed), { message: "a pass measured the clear button" }).toBe(true);
  const reads = await page.evaluate(() => (window as unknown as Counted).reads);
  expect(reads, "boxes read for one key").toBeLessThan(1_000);
});
