/**
 * Keyboard only: Tab through each screen from the top. Every stop shows focus
 * (WCAG 2.4.7) and is not hidden, not even partly, under a pinned bar or the
 * docked phone action (2.4.11, and the house bar); focus leaves the page at
 * the end (no trap, 2.1.2); on a phone the order reads top to bottom (2.4.3).
 * Dialogs and the account menu keep focus inside and give it back on Escape.
 */
import { writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { axNode, changedArea, focusStop, orderProblems, screenClip, settle, shot, stopProblems, tabWalk, type Rect } from "./checks";
import { backLink, isLaptop, open, run, setup, signIn, STATES } from "./screens";

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
  "result-transcript-tab",
  "result-regenerate",
  "failure",
  "review",
  "review-reject",
  "review-text-edit",
  "review-din-version",
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

// A page cannot hear Escape while focus is inside the browser's PDF viewer. The viewer either is no Tab stop (its
// content is a link away, in a tab of its own), or Tab leads out of it back to the dialog's own controls (WCAG
// 2.1.2). From those controls, Escape closes the dialog.
test("the PDF preview holds focus, never traps it in the viewer, and Escape closes it from the dialog", async ({ page }, info) => {
  test.skip(!isLaptop(info), "below a laptop's width the PDF opens in a new tab");
  await run(page, "run-done");
  const trigger = page.getByRole("button", { name: /^Öppna Protokoll .*\.pdf$/ });
  const dialog = page.getByRole("dialog");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await settle(page);
  const inFrame = () => page.evaluate(() => document.activeElement?.tagName === "IFRAME");
  expect.soft(await inFrame(), "focus starts on the dialog's own controls").toBe(false);
  const problems: string[] = [];
  // The frame's ring is measured without taking focus off it, which would move the viewer's own focus: on the
  // frame's box (its wrapper's, where the ring is) while the viewer has focus, and again once Tab has left it.
  let frame: { clip: Rect; focused: string; perimeter: number } | null = null;
  let leftFrame = false;
  let cycled = false;
  const seen = new Set<string>();
  // The viewer's own controls (a dozen or so) are stops inside the frame before Tab leads out of it.
  for (let presses = 0; presses < 60 && !leftFrame && !cycled; presses++) {
    if (await inFrame()) {
      if (!frame) {
        const box = await page.evaluate(() => {
          const r = document.activeElement!.parentElement!.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        });
        const clip = await screenClip(page, box);
        if (clip) frame = { clip, focused: await shot(page, clip), perimeter: 2 * (box.width + box.height) };
      }
    } else {
      const stop = await focusStop(page);
      const inside = await dialog.evaluate((element) => element.contains(document.activeElement));
      if (!stop || !inside) problems.push(`${stop?.label ?? "the page"} is outside the dialog`);
      else problems.push(...stopProblems([stop]));
      leftFrame = frame !== null;
      // Back at a stop already met, without meeting the viewer: Tab goes round the dialog's own controls.
      const key = stop ? `${stop.label}@${stop.left},${stop.top}` : "";
      cycled = seen.has(key);
      seen.add(key);
    }
    if (!leftFrame && !cycled) {
      await page.keyboard.press("Tab");
      // The viewer runs in a process of its own: focus reaches the page a moment after the key.
      await page.waitForTimeout(150);
    }
  }
  expect.soft(problems, "focus stays inside the dialog and is visible (WCAG 2.1.2, 2.4.7)").toEqual([]);
  if (frame) {
    expect(leftFrame, "Tab leads out of the viewer back to the dialog's controls").toBe(true);
    const ring = await changedArea(page, frame.focused, await shot(page, frame.clip), frame.clip.width);
    expect.soft(ring, "the viewer's frame shows focus (WCAG 2.4.7)").toBeGreaterThanOrEqual(frame.perimeter);
  } else {
    expect(cycled, "Tab goes round the dialog's controls").toBe(true);
    await expect(dialog.locator("iframe"), "the viewer is taken out of the Tab order").toHaveAttribute("tabindex", "-1");
    await expect(dialog.getByRole("link", { name: /ny flik/ }), "the file is a link away, in a tab of its own").toHaveAttribute("target", "_blank");
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger, "Escape gives focus back to what opened it").toBeFocused();
});

test("signed out, the sign-in dialog holds focus, with the recording's Pausa and Stoppa inside it", async ({ page }, info) => {
  await STATES.find((s) => s.name === "signed-out-recording")!.go(page, info);
  const dialog = page.getByRole("alertdialog", { name: "Du behöver logga in igen" });
  await settle(page);
  // The page's control that had focus is covered: focus moves into the dialog that appeared (WCAG 2.4.3).
  expect.soft(await dialog.evaluate((element) => element.contains(document.activeElement)), "focus moves into the sign-in dialog").toBe(true);
  await page.keyboard.press("Tab");
  const problems: string[] = [];
  const reached = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const stop = await focusStop(page);
    const inside = await dialog.evaluate((element) => element.contains(document.activeElement));
    if (!stop || !inside) problems.push(`${stop?.label ?? "the page"} is outside the dialog`);
    else {
      problems.push(...stopProblems([stop]));
      reached.add(stop.label);
    }
    await page.keyboard.press("Tab");
  }
  expect.soft(problems, "focus stays inside and is visible (WCAG 2.1.2, 2.4.7)").toEqual([]);
  expect([...reached]).toEqual(expect.arrayContaining(['button "Pausa"', 'button "Stoppa"', 'button "Logga in igen"']));
});

test("the naming dialog holds focus and gives it back", async ({ page }, info) => {
  await STATES.find((s) => s.name === "review")!.go(page, info);
  await holdsFocus(page, page.getByRole("button", { name: "Namnge talarna" }), page.getByRole("dialog", { name: "Namnge talarna" }));
});

test("the account menu holds focus and gives it back", async ({ page }) => {
  await STATES.find((s) => s.name === "flow-list")!.go(page, test.info());
  await holdsFocus(page, page.getByRole("button", { name: /^Öppna konto för/ }), page.getByRole("menu"), 0);
});

test("the warning before the login ends takes focus, holds it, and gives it back on Escape", async ({ page }) => {
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({
      json: { authenticated: true, auth_mode: "eneo_sso", user: { id: "user-1", email: "e@x.se" }, session_ends_in: 305 },
    }),
  );
  await open(page, "/flows");
  // Focus somewhere on the page before the warning opens (at five minutes before the end).
  const link = page.getByRole("link", { name: /Nämndmöte till rapport/ });
  await link.focus();
  const warning = page.getByRole("alertdialog", { name: "Du loggas snart ut" });
  await expect(warning).toBeVisible({ timeout: 15_000 });
  await settle(page);
  const problems: string[] = [];
  for (const key of ["Tab", "Tab", "Shift+Tab"]) {
    const stop = await focusStop(page);
    if (!stop || !(await warning.evaluate((element) => element.contains(document.activeElement)))) problems.push("focus left the warning");
    else problems.push(...stopProblems([stop]));
    await page.keyboard.press(key);
  }
  expect.soft(problems).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(warning).toBeHidden();
  await expect(link, "focus goes back to where it was").toBeFocused();
});

test("the microphone picker holds focus and gives it back", async ({ page }) => {
  await setup(page);
  await page.getByRole("radio", { name: /^Spela in/ }).click();
  await holdsFocus(page, page.getByRole("combobox", { name: "Mikrofon" }), page.getByRole("listbox"), 0);
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

test("a wrong access code is said, and focus stays in the field to type it again", async ({ page }) => {
  await page.route("**/api/auth/login", (route) => route.fulfill({ status: 401, json: { detail: "Felaktig åtkomstkod" } }));
  await signIn(page, "access_code");
  const field = page.getByLabel("Åtkomstkod");
  await field.fill("fel-kod");
  await field.press("Enter");
  await expect(page.getByText("Felaktig åtkomstkod.")).toBeVisible();
  // The field is locked while the code is checked, which drops focus; the answer gives it back (WCAG 2.4.3, 3.3.1).
  await expect(field).toBeFocused();
});

test("Antal talare keeps what was typed: a letter is an error the start sends focus back to", async ({ page }) => {
  await setup(page);
  await page.getByRole("radio", { name: /^Spela in/ }).click();
  await page.getByRole("switch", { name: "Märk upp talare" }).click();
  const count = page.getByRole("textbox", { name: /^Antal talare/ });
  await count.focus();
  // A number field would read "e" as empty and let the run start without a count.
  await page.keyboard.type("e");
  await expect(count).toHaveValue("e");
  await expect(count).toHaveAttribute("aria-invalid", "true");
  expect((await axNode(count)).description).toContain("Skriv ett heltal från 1 till 20, eller lämna fältet tomt.");
  await page.getByRole("button", { name: "Starta inspelning" }).click();
  await expect(count, "the start is refused and the field takes focus").toBeFocused();
  await expect(page.getByRole("button", { name: "Stoppa" })).toHaveCount(0);
});
