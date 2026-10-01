/**
 * The result's two tabs below a laptop's width, as a person uses them: the keyboard's way along the strip, and the place
 * each tab keeps. Both are behaviour the design system's tab strip and layout must not change.
 */
import { expect, test } from "@playwright/test";
import { isLaptop, result } from "./screens";

test.beforeEach(({}, info) => test.skip(isLaptop(info) || info.project.name === "reduced-motion", "the tabs are below a laptop's width"));

test("the tabs are one Tab stop: the arrows move along the strip, and Enter chooses the tab that has focus", async ({ page }) => {
  await result(page);
  const document_ = page.getByRole("tab", { name: "Dokument" });
  const transcript = page.getByRole("tab", { name: "Transkript" });
  await document_.focus();
  await page.keyboard.press("ArrowRight");
  await expect(transcript, "the arrow moves focus along the strip").toBeFocused();
  await expect(document_, "and chooses nothing: the document is still the one shown").toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(transcript).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Transkript" })).toBeVisible();
  await expect(page.getByRole("tabpanel", { name: "Dokument" })).toBeHidden();
  // Tab leaves the strip for the panel's own controls, not for the other tab.
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("role")), "the chosen tab is the strip's one Tab stop").not.toBe("tab");
});

test("each tab keeps its own place on the page, and the first visit to a tab starts at the strip", async ({ page }, info) => {
  test.skip(info.project.name.startsWith("tablet"), "the page is shorter than the screen");
  await result(page);
  // The strip is off the screen once the page is scrolled past it (Pausa's "Visa i transkriptet" changes tab from there):
  // the click is sent to the tab without Playwright scrolling it into view first.
  const choose = (name: string) => page.getByRole("tab", { name }).dispatchEvent("click");
  const scrollY = () => page.evaluate(() => Math.round(window.scrollY));
  await page.evaluate(() => window.scrollTo(0, 260));
  const inDocument = await scrollY();
  expect(inDocument, "the document is longer than the screen").toBeGreaterThan(100);
  await choose("Transkript");
  const strip = await page.getByRole("tablist", { name: "Visa" }).evaluate((element) => Math.round(element.getBoundingClientRect().top + window.scrollY - 8));
  expect.soft(Math.abs((await scrollY()) - Math.min(inDocument, strip)), "the transcript starts at the strip").toBeLessThanOrEqual(2);
  await page.evaluate(() => window.scrollTo(0, 190));
  const inTranscript = await scrollY();
  await choose("Dokument");
  expect(Math.abs((await scrollY()) - inDocument), "back in the document where it was left").toBeLessThanOrEqual(2);
  await choose("Transkript");
  expect(Math.abs((await scrollY()) - inTranscript), "and in the transcript").toBeLessThanOrEqual(2);
});
