/**
 * The speaker-review editor (docs/eneo-integration.md, "Granskning och talarmappning"), the part of the review the flag
 * keeps out of every run and the gate's states cannot work: selection with the keyboard, a speaker given to the words
 * and taken back, a word that moves the playback, and the way between the text and its tools. The development page's
 * fixtures carry it.
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./gate";
import { pick, reviewEditor } from "./screens";

test.beforeEach(({}, info) => test.skip(!["laptop-1440-light", "phone-390-light"].includes(info.project.name), "two widths are enough"));

const transcript = (page: Page) => page.getByRole("textbox", { name: "Transkribering, markera ord för att redigera" });
const tools = (page: Page) => page.getByRole("group", { name: "Verktyg för transkriberingen" });
/** What the tools say about the last change: each design-system button holds a live region of its own, empty. */
const said = (page: Page) => tools(page).getByRole("status").filter({ hasText: /\S/ });

test("words selected with Shift and the arrows are given to a speaker, and Ångra takes the speaker back", async ({ page }) => {
  await reviewEditor(page);
  const text = transcript(page);
  await text.focus();
  // The caret at the start of the text, as a person who tabbed into it has it.
  await text.evaluate((element) => {
    const first = element.querySelector("[data-word-start]")!.firstChild!;
    getSelection()!.setBaseAndExtent(first, 0, first, 0);
  });
  for (let i = 0; i < 12; i++) await page.keyboard.press("Shift+ArrowRight");
  const marked = page.getByRole("group", { name: "Markerade ord" });
  await expect(marked, "the words are marked, and the tools for them appear").toBeVisible();
  await expect(marked).toContainText("Nu har vi");

  // Who the first stretch of text is given to, as its name button says it.
  const firstSpeaker = () => text.getByRole("button", { name: /^Markera stycket:/ }).first().getAttribute("aria-label");
  const before = await firstSpeaker();
  expect(before).not.toContain("Karin");

  await pick(marked.getByRole("combobox", { name: "Tilldela talare" }), "Karin");
  await expect(said(page)).toContainText(/ord tilldelade Karin\./);
  expect(await firstSpeaker()).toContain("Karin");
  await expect(text, "the words themselves are untouched").toContainText("Nu har vi pratat");

  await tools(page).getByRole("button", { name: "Ångra", exact: true }).click();
  await expect(said(page)).toHaveText("Ändringen är ångrad.");
  await expect(tools(page).getByRole("button", { name: "Ångra", exact: true })).toHaveCount(0);
  expect(await firstSpeaker(), "the speaker is as it was").toBe(before);
  await expect(text, "the focus is back in the text").toBeFocused();
});

test("a click on a word moves the playback to it", async ({ page }) => {
  await page.goto("/dev/speaker-review");
  await pick(page.getByRole("combobox", { name: "Testfall" }), "operator");
  await page.getByRole("checkbox", { name: "Tillgängligt testljud" }).check();
  await expect(transcript(page)).toBeVisible();
  const word = page.locator("[data-word-start]", { hasText: /^skrivit$/ }).first();
  const at = Number(await word.getAttribute("data-word-start"));
  expect(at, "a word of the first passage, well after its start").toBeGreaterThan(0.4);
  await word.click();
  await expect.poll(() => page.locator("audio").first().evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeCloseTo(at, 1);
  // A word is lit: the one clicked, or the one before it when the audio rounds the position down to a sample.
  const lit = transcript(page).locator('[aria-current="true"]');
  await expect(lit).toHaveCount(1);
  expect(Math.abs(Number(await lit.getAttribute("data-word-start")) - at)).toBeLessThan(0.1);
});

test("Tab goes on through the text and Alt+T reaches its tools", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await reviewEditor(page);
  await page.getByRole("button", { name: "Nästa passage som behöver talarbeslut" }).click();
  await expect(page.getByRole("group", { name: "Markerade ord" })).toBeVisible();
  const text = transcript(page);
  await text.focus();
  // A selected passage must not make Tab cycle back through the toolbar.
  await page.keyboard.press("Tab");
  expect(await tools(page).evaluate((toolbar) => toolbar.contains(document.activeElement))).toBe(false);
  await text.focus();
  await page.keyboard.press("Alt+t");
  expect(await tools(page).evaluate((toolbar) => toolbar.contains(document.activeElement))).toBe(true);
  // Escape from the text clears the marking.
  await text.focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: "Markerade ord" })).toHaveCount(0);
  expect(errors, "Escape with a marked passage and no selection in the browser's sense is no error").toEqual([]);
});
