/**
 * The result's two tabs below a laptop's width, as a person uses them: the keyboard's way along the strip, and the place
 * each tab keeps. Both are behaviour the design system's tab strip and layout must not change.
 */
import { passagesQuote } from "./checks";
import { expect, test } from "./gate";
import { isLaptop, result, run } from "./screens";
import ids from "../fixtures/ids.json";

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

test("a copy from the transcript's menu that the clipboard refuses says so beside the menu, and the next one is copied", async ({ page }) => {
  // The narrowest phone: the transcript's copy and download fold into its menu there. On a wider phone they stand in the
  // row, which under the tabs holds no heading of its own.
  await page.setViewportSize({ width: 320, height: 568 });
  // A clipboard that refuses until it is let through, as a page without the permission and then with it.
  await page.addInitScript(() => {
    const state = window as unknown as { clipboardRefuses: boolean };
    state.clipboardRefuses = true;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          if (state.clipboardRefuses) throw new DOMException("Refused", "NotAllowedError");
        },
      },
    });
  });
  await result(page);
  await page.getByRole("tab", { name: "Transkribering" }).click();
  const menu = page.getByRole("button", { name: "Fler alternativ för transkriberingen" });
  const failed = page.getByText("Kunde inte kopiera", { exact: true });
  await menu.click();
  await page.getByRole("menuitem", { name: "Kopiera transkriberingen" }).click();
  await expect(failed, "the refusal is said where the person looks, not only to a screen reader").toBeVisible();

  await page.evaluate(() => ((window as unknown as { clipboardRefuses: boolean }).clipboardRefuses = false));
  await menu.click();
  await page.getByRole("menuitem", { name: "Kopiera transkriberingen" }).click();
  await expect(failed).toBeHidden();
});

test("the head's lines: the flow's name and when it was made on one line from 360 px, each on its own under it, and the details in two lines at most", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("phone"), "a phone's widths, the narrowest and the common one");
  await result(page);
  const flow = page.getByRole("main").locator("p", { hasText: /^Nämndmöte till rapport/ }).first();
  const made = page.getByRole("main").locator("p", { hasText: /^Skapad / }).first();
  const [a, b] = [await flow.boundingBox(), await made.boundingBox()];
  const narrowest = info.project.use.viewport!.width < 360;
  if (narrowest) {
    expect(b!.y, "when it was made, under the flow's name").toBeGreaterThanOrEqual(a!.y + a!.height - 1);
    await expect(page.getByRole("main").getByText("·", { exact: true }), "no dot left at the end of a line").toHaveCount(0);
  } else {
    expect(Math.abs(b!.y - a!.y), "beside each other").toBeLessThan(4);
  }
  const details = page.getByRole("main").locator("p", { hasText: /^Deltagare: / }).first();
  expect(await details.evaluate((line) => getComputedStyle(line).webkitLineClamp), "two lines at most").toBe("2");
});

test("the dot after the flow's name stays beside its last word, also where a long name wraps", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390-light", "a phone's line");
  const name = "Nämndmöte till strukturerat protokoll med beslut och bilagor";
  await page.route("**/api/eneo/flows/*/published/", async (route) => route.fulfill({ json: { ...(await (await route.fetch()).json()), name } }));
  await result(page);
  const dot = page.getByRole("main").getByText(/^\s*[·・]\s*$/).first();
  const flow = page.getByRole("main").locator("p", { hasText: name }).first();
  const end = await flow.evaluate((line) => {
    const range = document.createRange();
    range.selectNodeContents(line.firstChild!);
    const rects = range.getClientRects();
    return { right: rects[rects.length - 1].right, top: rects[rects.length - 1].top, lines: rects.length };
  });
  const glyph = await dot.evaluate((element) => {
    const text = element.firstChild as Text;
    const range = document.createRange();
    const at = text.data.search(/[·・]/);
    range.setStart(text, at);
    range.setEnd(text, at + 1);
    return range.getBoundingClientRect();
  });
  expect(end.lines, "the name wraps on a phone").toBeGreaterThan(1);
  expect(Math.abs(glyph.top - end.top), "on the name's last line").toBeLessThan(4);
  expect(glyph.left - end.right, "right after its last word").toBeLessThanOrEqual(8);
  expect(await dot.textContent(), "the middle dot, not a katakana one from a fallback font").toContain("·");
});

test("the tab strip owns only its tabs, also while the document can be made again with the corrections", async ({ page }) => {
  await run(page, ids.runs.corrected);
  await expect(page.getByText("Dokumentet skapades före dina ändringar")).toBeVisible();
  await page.getByRole("tab", { name: "Transkribering" }).click();
  const strip = page.getByRole("tablist");
  await expect(strip.getByRole("tab", { name: /kan skapas igen/ })).toBeVisible();
  const owned = await strip.evaluate((list) => [...list.querySelectorAll("*")].filter((element) => element.getAttribute("role") === "tooltip").length);
  expect(owned, "no tooltip in the tab strip").toBe(0);
});

test("the tab chosen is kept for the run through a reload, as a phone's browser does to a tab in the background", async ({ page }) => {
  await result(page);
  await page.getByRole("tab", { name: "Transkribering" }).click();
  await page.reload();
  await expect(page.getByRole("tab", { name: "Transkribering" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Dokument" }).click();
  await page.reload();
  await expect(page.getByRole("tab", { name: "Dokument" })).toHaveAttribute("aria-selected", "true");
});

test("a passage copied by hand on a phone keeps its speaker, its time and its words, without the buttons' words or the hidden notes", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390-light", "one phone");
  await run(page, ids.runs.corrected);
  await page.getByRole("tab", { name: "Transkribering" }).click();
  await expect(page.locator("[data-correction-note]").first()).toBeAttached();
  const quote = await passagesQuote(page);
  expect(quote).toContain("Talare 1");
  expect(quote).toContain("0:00");
  expect(quote).toContain("Fler turer börjar gälla efter höstlovet.");
  expect(quote, "the passage's own button").not.toContain("Rätta");
  expect(quote, "the corrected word's note, for a screen reader").not.toContain("rättad från");
});
