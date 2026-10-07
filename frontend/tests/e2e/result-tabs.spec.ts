/**
 * The result's two tabs below a laptop's width, as a person uses them: the keyboard's way along the strip, and the place
 * each tab keeps. Both are behaviour the design system's tab strip and layout must not change.
 */
import { expect, test } from "./gate";
import { isLaptop, result } from "./screens";

test.beforeEach(({}, info) => test.skip(isLaptop(info) || info.project.name === "reduced-motion", "the tabs are below a laptop's width"));

test("the tabs are one Tab stop: the arrows move along the strip, and Enter chooses the tab that has focus", async ({ page }) => {
  await result(page);
  const document_ = page.getByRole("tab", { name: "Dokument" });
  const transcript = page.getByRole("tab", { name: "Transkribering" });
  await document_.focus();
  await page.keyboard.press("ArrowRight");
  await expect(transcript, "the arrow moves focus along the strip").toBeFocused();
  await expect(document_, "and chooses nothing: the document is still the one shown").toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(transcript).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Transkribering" })).toBeVisible();
  await expect(page.getByRole("tabpanel", { name: "Dokument" })).toBeHidden();
  // Tab leaves the strip for the panel's own controls, not for the other tab.
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("role")), "the chosen tab is the strip's one Tab stop").not.toBe("tab");
});

test("each tab keeps its own place on the page, and the first visit to a tab starts at the strip", async ({ page }, info) => {
  // Both panels must scroll for this proof, also at the widest single-column layout.
  await page.setViewportSize({ width: info.project.use.viewport!.width, height: 400 });
  await result(page);
  // The strip is off the screen once the page is scrolled past it (Pausa's "Visa i transkriberingen" changes tab from there):
  // the click is sent to the tab without Playwright scrolling it into view first.
  const choose = (name: string) => page.getByRole("tab", { name }).dispatchEvent("click");
  const scrollY = () => page.evaluate(() => Math.round(window.scrollY));
  await page.evaluate(() => window.scrollTo(0, 260));
  const inDocument = await scrollY();
  expect(inDocument, "the document is longer than the screen").toBeGreaterThan(100);
  await choose("Transkribering");
  const strip = await page.getByRole("tablist", { name: "Visa" }).evaluate((element) => Math.round(element.getBoundingClientRect().top + window.scrollY - 8));
  expect.soft(Math.abs((await scrollY()) - Math.min(inDocument, strip)), "the transcript starts at the strip").toBeLessThanOrEqual(2);
  await page.evaluate(() => window.scrollTo(0, 190));
  const inTranscript = await scrollY();
  await choose("Dokument");
  expect(Math.abs((await scrollY()) - inDocument), "back in the document where it was left").toBeLessThanOrEqual(2);
  await choose("Transkribering");
  expect(Math.abs((await scrollY()) - inTranscript), "and in the transcript").toBeLessThanOrEqual(2);
});

test("Visa i transkriberingen on the docked player takes the person to the transcript's tab, with the focus on it", async ({ page }) => {
  await result(page);
  await page.getByRole("tab", { name: "Transkribering" }).click();
  await page.getByRole("button", { name: "Spela upp", exact: true }).first().click();
  await page.getByRole("tab", { name: "Dokument" }).click();
  // The button that was pressed goes with the tab it was on: the focus does not fall to the page.
  await page.getByRole("button", { name: "Visa i transkriberingen" }).click();
  await expect(page.getByRole("tab", { name: "Transkribering" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Transkribering" })).toBeFocused();
});
