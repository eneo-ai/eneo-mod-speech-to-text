/**
 * The speaker review's editable transcript, which the module's pages keep behind a flag (NEXT_PUBLIC_SPEAKER_REVIEW_ENABLED):
 * the development page of its test cases, with the test audio ticked. What README "Granska transkriptet" describes, as a
 * person does it: selecting with the keyboard, giving the words to a speaker, undoing, and moving the playback by a word.
 */
import { expect, test } from "@playwright/test";
import { STATES } from "./screens";

test("words are selected with Shift and the arrow keys, given to a speaker, and the change is undone", async ({ page }, info) => {
  await STATES.find((s) => s.name === "speaker-review")!.go(page, info);
  const text = page.getByRole("textbox", { name: /^Transkript, markera ord/ });
  const tools = page.getByRole("group", { name: "Transkriptverktyg" });
  // The caret at the start of the first passage, as a click in the text would put it (a click also moves the playback).
  await text.evaluate((element) => {
    const first = element.querySelector('[data-text-span="0"]')!;
    const walker = document.createTreeWalker(first, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    range.setStart(walker.nextNode()!, 0);
    range.collapse(true);
    (element as HTMLElement).focus();
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  for (let i = 0; i < 13; i++) await page.keyboard.press("Shift+ArrowRight");
  const selected = page.getByRole("group", { name: "Markerade ord" });
  await expect(selected, "the words chosen show their tools").toBeVisible();

  await selected.getByRole("combobox", { name: "Tilldela talare" }).click();
  await page.getByRole("option", { name: "Karin" }).click();
  await expect(tools.getByText(/ord tilldelade Karin\./), "said in the live region").toBeVisible();
  const undo = tools.getByRole("button", { name: "Ångra" });
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(tools.getByText("Ändringen är ångrad.")).toBeVisible();
  await expect(undo).toBeHidden();
});

test("a click on a word moves the playback there", async ({ page }, info) => {
  await STATES.find((s) => s.name === "speaker-review")!.go(page, info);
  const position = page.getByRole("slider", { name: "Position i inspelningen" });
  const before = await position.getAttribute("aria-valuenow");
  // A word of the third passage, 1.6 s into the four seconds of test audio.
  await page.locator('[data-text-span="2"] [data-word-start]').first().click();
  await expect.poll(() => position.getAttribute("aria-valuenow")).not.toBe(before);
});
