/**
 * Keyboard only: Tab through each screen from the top. Every stop shows focus
 * (WCAG 2.4.7) and is not hidden, not even partly, under a pinned bar or the
 * docked phone action (2.4.11, and the house bar); focus leaves the page at
 * the end (no trap, 2.1.2); on a phone the order reads top to bottom (2.4.3).
 * Dialogs and the account menu keep focus inside and give it back on Escape.
 */
import { writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { axNode, changedArea, clippedFocus, focusStop, orderProblems, screenClip, settle, shot, stopProblems, tabWalk, TEXT_SPACING, type Rect } from "./checks";
import { backLink, isLaptop, isPhone, run, setup, signIn, STATES } from "./screens";
import ids from "../fixtures/ids.json";

const WALKS = [
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

// The docked action of a phone grows with its words and with the spacing a reader may set (WCAG 1.4.12): focus must
// still stop above it, whatever its height is.
for (const name of ["setup", "setup-participants", "setup-microphone-check"]) {
  test(`tab through ${name} with the text spacing a reader may set`, async ({ page }, info) => {
    test.skip(!isPhone(info), "the docked action is a phone's");
    await STATES.find((s) => s.name === name)!.go(page, info);
    await page.addStyleTag({ content: TEXT_SPACING });
    const { stops, left } = await tabWalk(page);
    writeFileSync(info.outputPath("stops.json"), JSON.stringify(stops, null, 2));
    expect(stops.length, "something to focus").toBeGreaterThan(0);
    expect.soft(left, `focus never leaves the page after ${stops.length} stops (WCAG 2.1.2)`).toBe(true);
    expect.soft(stopProblems(stops), "focus visible and unobscured").toEqual([]);
  });
}

/**
 * Tab has left the page for the browser's own controls (the document has no focus). A native modal dialog lets Tab
 * do that, as a trap would break WCAG 2.1.2; it never lets Tab reach the page behind it.
 */
const inBrowser = (page: Page) => page.evaluate(() => !document.hasFocus());

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
    if (!(await inBrowser(page))) {
      // At rest: the tooltip of the control that has the focus enters over a few frames, and in them overlaps it.
      await settle(page);
      const stop = await focusStop(page);
      const inside = await popup.evaluate((element) => element.contains(document.activeElement));
      if (!stop || !inside) problems.push(`${stop?.label ?? "the page"} is outside the ${await popup.getAttribute("role")}`);
      else problems.push(...stopProblems([stop]));
    }
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
  await run(page, ids.runs.running);
  await holdsFocus(page, page.getByRole("button", { name: "Avbryt körningen" }), page.getByRole("alertdialog", { name: "Avbryta körningen?" }));
});

// A page cannot hear Escape while focus is inside the browser's PDF viewer. The viewer either is no Tab stop (its
// content is a link away, in a tab of its own), or Tab leads out of it back to the dialog's own controls (WCAG
// 2.1.2). From those controls, Escape closes the dialog.
test("the PDF preview holds focus, never traps it in the viewer, and Escape closes it from the dialog", async ({ page }, info) => {
  test.skip(!isLaptop(info), "below a laptop's width the PDF opens in a new tab");
  await run(page, ids.runs.done);
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
    } else if (!(await inBrowser(page))) {
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
    if (!(await inBrowser(page))) {
      const stop = await focusStop(page);
      const inside = await dialog.evaluate((element) => element.contains(document.activeElement));
      if (!stop || !inside) problems.push(`${stop?.label ?? "the page"} is outside the dialog`);
      else {
        problems.push(...stopProblems([stop]));
        const clipped = await clippedFocus(page);
        if (clipped) problems.push(`${stop.label}: its focus ring is cut by ${clipped}`);
        reached.add(stop.label);
      }
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

test("Escape closes the name list and leaves the naming dialog open; the next one closes the dialog, with the names kept", async ({ page }, info) => {
  await STATES.find((s) => s.name === "naming-dialog")!.go(page, info);
  const dialog = page.getByRole("dialog", { name: "Namnge talarna" });
  const field = dialog.getByRole("combobox", { name: "Vem är Talare 3?" });
  const list = page.getByRole("listbox", { name: "Förslag: Vem är Talare 3?" });
  await field.fill("Bertil Eklund");
  await expect(list, "typing opens the list").toBeVisible();
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expect(dialog, "the list was the top layer: the dialog stays").toBeVisible();
  await expect(field, "and the focus stays in the field").toBeFocused();
  await expect(field).toHaveValue("Bertil Eklund");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Namnge talarna" }).click();
  await expect(dialog.getByRole("combobox", { name: "Vem är Talare 3?" }), "closed with Escape, the typed name is kept").toHaveValue("Bertil Eklund");
});

test("Tab closes the name list at once, and the next control is reached and not covered", async ({ page }, info) => {
  await STATES.find((s) => s.name === "naming-dialog")!.go(page, info);
  const dialog = page.getByRole("dialog", { name: "Namnge talarna" });
  const field = dialog.getByRole("combobox", { name: "Vem är Talare 2?" });
  const list = page.getByRole("listbox", { name: "Förslag: Vem är Talare 2?" });
  await field.click();
  await expect(list).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(list).toBeHidden();
  const stop = await focusStop(page);
  expect(stop, "focus moved on, inside the dialog").not.toBeNull();
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  expect(stopProblems(stop ? [stop] : []), "visible and not covered").toEqual([]);
});

test("the account menu holds focus and gives it back", async ({ page }) => {
  await STATES.find((s) => s.name === "flow-list")!.go(page, test.info());
  await holdsFocus(page, page.getByRole("button", { name: /^Öppna konto för/ }), page.getByRole("menu"), 0);
});

test("the warning before the login ends takes focus, holds it, and gives it back on Escape", async ({ page }) => {
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({
      json: { authenticated: true, user: { id: "user-1", email: "e@x.se" }, session_ends_in: 305 },
    }),
  );
  await page.goto("/flows");
  // Focus somewhere on the page before the warning opens (at five minutes before the end).
  const link = page.getByRole("link", { name: /Nämndmöte till rapport/ });
  await link.focus();
  const warning = page.getByRole("alertdialog", { name: "Du loggas snart ut" });
  await expect(warning).toBeVisible({ timeout: 15_000 });
  await settle(page);
  // The dialog takes focus on its title, which names it (it is no Tab stop, so it needs no ring); Tab then walks
  // the close button and the action.
  await expect(warning.getByRole("heading", { name: "Du loggas snart ut" })).toBeFocused();
  const problems: string[] = [];
  // Down to the close button, the action, back up, and down again: the walk ends on the action.
  for (const key of ["Tab", "Tab", "Shift+Tab", "Tab"]) {
    await page.keyboard.press(key);
    if (await inBrowser(page)) continue;
    // A tooltip is measured at rest, as a dialog is: not on its way in.
    await settle(page);
    const stop = await focusStop(page);
    if (!stop || !(await warning.evaluate((element) => element.contains(document.activeElement)))) problems.push("focus left the warning");
    else {
      problems.push(...stopProblems([stop]));
      const clipped = await clippedFocus(page);
      if (clipped) problems.push(`${stop.label}: its focus ring is cut by ${clipped}`);
    }
  }
  expect.soft(problems).toEqual([]);
  // The close button's tooltip leaves a moment after focus does, and takes the first Escape if it is still there.
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(warning).toBeHidden();
  await expect(link, "focus goes back to where it was").toBeFocused();
});

// A combobox keeps the position in its list in aria-activedescendant: the focus stays on the combobox while the list
// is open (a list that holds the focus itself is allowed too). The arrow keys move the active option, Enter chooses,
// and Escape closes the list and gives the focus back to the combobox.
test("the microphone picker is operated with the keyboard and gives the focus back", async ({ page }) => {
  await setup(page);
  await page.getByRole("radio", { name: /^Spela in/ }).click();
  const picker = page.getByRole("combobox", { name: "Mikrofon" });
  await picker.focus();
  await page.keyboard.press("Enter");
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  await settle(page);
  expect.soft(await page.evaluate(() => document.activeElement?.tagName), "focus does not start in a frame").not.toBe("IFRAME");
  const active = () =>
    page.evaluate(() => {
      const owner = document.activeElement as HTMLElement | null;
      const id = owner?.getAttribute("aria-activedescendant");
      return { owner: owner?.getAttribute("role"), option: id ? (document.getElementById(id)?.textContent ?? null) : null };
    });
  const first = await active();
  expect(["combobox", "listbox"], "focus is on the combobox or its list").toContain(first.owner);
  expect(first.option, "an option is active").toBeTruthy();
  await page.keyboard.press("ArrowDown");
  expect((await active()).option, "the arrow key moves the active option").not.toBe(first.option);
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expect(picker, "Escape gives focus back to the combobox").toBeFocused();
});

test("the input modes change with the arrow keys", async ({ page }) => {
  await setup(page);
  const cards = page.getByRole("radio");
  await page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" }).focus();
  await page.keyboard.press("Tab");
  await expect(cards.first(), "Tab reaches the chosen mode").toBeFocused();
  await page.keyboard.press("ArrowDown");
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
  // The names follow the field, and "Lägg till" is only there while a name is typed: Tab reaches the first name's button.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Ta bort Anna Berg" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Ta bort Anna Berg" })).toBeHidden();
  await expect(input, "removing a name keeps focus in the field").toBeFocused();
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

test("the input modes are one Tab stop: every arrow moves and chooses, round the ends, the setup follows, Tab leaves", async ({ page }) => {
  await setup(page);
  const cards = page.getByRole("radio");
  await expect(cards).toHaveCount(3);
  const ACTION = ["Starta strömning", "Starta inspelning", "Välj ljudfil"];
  const primary = page.getByRole("button", { name: new RegExp(`^(${ACTION.join("|")})$`) });
  // A chosen mode other than the first: Tab enters the group where the choice is, not at its top.
  await cards.nth(1).click();
  await page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" }).focus();
  await page.keyboard.press("Tab");
  await expect(cards.nth(1), "Tab enters at the chosen mode").toBeFocused();
  for (const [key, to] of [["ArrowDown", 2], ["ArrowDown", 0], ["ArrowUp", 2], ["ArrowLeft", 1], ["ArrowRight", 2], ["ArrowRight", 0]] as const) {
    await page.keyboard.press(key);
    await expect(cards.nth(to), `${key} moves focus to mode ${to + 1}`).toBeFocused();
    await expect(cards.nth(to), `${key} chooses mode ${to + 1}`).toBeChecked();
    await expect(primary, "the start action follows the chosen mode").toHaveText(ACTION[to]);
  }
  await expect(page.getByRole("button", { name: "Testa mikrofonen" }), "Strömma's own setup shows").toBeVisible();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("role")), "the next Tab leaves the group").not.toBe("radio");
  await expect(page.getByRole("switch", { name: "Märk upp talare" })).toBeFocused();
});
