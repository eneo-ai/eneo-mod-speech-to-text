/**
 * Keyboard only: Tab through each screen from the top. Every stop shows focus
 * (WCAG 2.4.7) and is not hidden, not even partly, under a pinned bar or the
 * docked phone action (2.4.11, and the house bar); focus leaves the page at
 * the end (no trap, 2.1.2); on a phone the order reads top to bottom (2.4.3).
 * Dialogs and the account menu keep focus inside and give it back on Escape.
 */
import { writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { focusStop, orderProblems, settle, stopProblems, tabWalk } from "./checks";
import { backLink, isLaptop, run, setup, STATES } from "./screens";

const WALKS = [
  "signin-access-code",
  "flow-list",
  "unsent-recordings",
  "setup-participants",
  "setup-microphone-check",
  "setup-required-detail",
  "upload-chosen-file",
  "recording",
  "recording-details-open",
  "stromma",
  "ready",
  "run-progress",
  "result",
  "failure",
  "review",
  "flow-republish-required",
];

for (const name of WALKS) {
  test(`tab through ${name}`, async ({ page }, info) => {
    const state = STATES.find((s) => s.name === name)!;
    test.skip(state.only ? !state.only(info) : false, "not on this width");
    await state.go(page, info);
    const { stops, left } = await tabWalk(page);
    writeFileSync(info.outputPath("stops.json"), JSON.stringify(stops, null, 2));
    expect(stops.length, "something to focus").toBeGreaterThan(0);
    expect.soft(left, `focus never leaves the page after ${stops.length} stops (WCAG 2.1.2)`).toBe(true);
    expect.soft(stopProblems(stops), "focus visible and unobscured").toEqual([]);
    if (!isLaptop(info)) {
      expect.soft(orderProblems(stops), "focus order follows the reading order (WCAG 2.4.3)").toEqual([]);
    }
  });
}

/** Opens a dialog or menu from its trigger with Enter, keeps Tab inside it, and closes it with Escape. */
async function holdsFocus(page: Page, trigger: Locator, popup: Locator, tabs = 4) {
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(popup).toBeVisible();
  await settle(page);
  // Escape cannot reach the dialog from inside a frame (the PDF viewer), so focus must not start there.
  expect.soft(await page.evaluate(() => document.activeElement?.tagName), "focus starts on the dialog's own controls").not.toBe("IFRAME");
  const problems: string[] = [];
  const keys = [...Array(tabs).fill("Tab"), ...Array(Math.min(tabs, 2)).fill("Shift+Tab")];
  for (let i = 0; i <= keys.length; i++) {
    const stop = await focusStop(page);
    const inside = await popup.evaluate((element) => element.contains(document.activeElement));
    if (!stop || !inside) problems.push(`${stop?.label ?? "the page"} is outside the ${await popup.getAttribute("role")}`);
    else problems.push(...stopProblems([stop]));
    if (keys[i]) await page.keyboard.press(keys[i]);
  }
  expect.soft(problems, "focus stays inside and is visible (WCAG 2.1.2, 2.4.7)").toEqual([]);
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await expect(trigger, "Escape gives focus back to what opened it").toBeFocused();
}

test("the delete question holds focus and gives it back", async ({ page }, info) => {
  await STATES.find((s) => s.name === "ready")!.go(page, info);
  await holdsFocus(page, page.getByRole("button", { name: "Ta bort" }), page.getByRole("alertdialog", { name: "Ta bort inspelningen?" }));
});

test("the leave question holds focus and gives it back", async ({ page }, info) => {
  await STATES.find((s) => s.name === "recording")!.go(page, info);
  await holdsFocus(page, backLink(page), page.getByRole("alertdialog", { name: "Lämna sidan?" }));
});

test("the cancel question holds focus and gives it back", async ({ page }) => {
  await run(page, "run-running");
  await holdsFocus(page, page.getByRole("button", { name: "Avbryt körningen" }), page.getByRole("alertdialog", { name: "Avbryta körningen?" }));
});

test("the PDF preview holds focus and gives it back", async ({ page }, info) => {
  test.skip(!isLaptop(info) && info.project.name !== "zoom-200", "a phone opens the PDF in a new tab");
  await run(page, "run-done");
  await holdsFocus(page, page.getByRole("button", { name: /^Öppna Protokoll .*\.pdf$/ }), page.getByRole("dialog"));
});

test("the account menu holds focus and gives it back", async ({ page }) => {
  await STATES.find((s) => s.name === "flow-list")!.go(page, test.info());
  await holdsFocus(page, page.getByRole("button", { name: /^Öppna konto för/ }), page.getByRole("menu"), 0);
});

test("the input modes change with the arrow keys", async ({ page }) => {
  await setup(page);
  const cards = page.getByRole("radio");
  await page.getByRole("heading", { name: "Hur vill du ge ljudet?" }).focus();
  await page.keyboard.press("Tab");
  await expect(cards.first(), "Tab reaches the chosen mode").toBeFocused();
  // Held like a finger holds a key: Radix moves focus after the key goes down and checks while it is held.
  await page.keyboard.down("ArrowDown");
  await page.waitForTimeout(60);
  await page.keyboard.up("ArrowDown");
  await expect(cards.nth(1)).toBeFocused();
  await expect(cards.nth(1), "the arrow key chooses the mode it moves to").toBeChecked();
});

test("participants are added and removed from the keyboard", async ({ page }) => {
  await setup(page);
  await page.getByRole("radio", { name: /^Spela in/ }).click();
  const input = page.getByRole("textbox", { name: /^Deltagare/ });
  await input.focus();
  await page.keyboard.type("Anna Berg");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Erik Lund,");
  await expect(page.getByRole("button", { name: "Ta bort Erik Lund" })).toBeVisible();
  await page.keyboard.press("Backspace");
  await expect(page.getByRole("button", { name: "Ta bort Erik Lund" })).toBeHidden();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Ta bort Anna Berg" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Ta bort Anna Berg" })).toBeHidden();
  await expect(input, "removing a name keeps focus in the field").toBeFocused();
});
