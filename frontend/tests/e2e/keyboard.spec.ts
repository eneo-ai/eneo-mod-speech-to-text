/**
 * Keyboard only: Tab through each screen from the top. Every stop shows focus
 * (WCAG 2.4.7) and is not hidden, not even partly, under a pinned bar or the
 * docked phone action (2.4.11, and the house bar); focus leaves the page at
 * the end (no trap, 2.1.2); on a phone the order reads top to bottom (2.4.3).
 * Dialogs and the account menu keep focus inside and give it back on Escape.
 */
import { writeFileSync } from "node:fs";
import { type Locator, type Page } from "@playwright/test";
import { expect, test } from "./gate";
import { addStyles, axNode, changedArea, clippedFocus, focusStop, orderProblems, screenClip, settle, shot, stopProblems, tabKey, tabWalk, TEXT_SPACING, type Rect } from "./checks";
import { backLink, chooseMode, isLaptop, isPhone, needsRecording, pdfInDialog, result, run, setup, STATES } from "./screens";
import ids from "../fixtures/ids.json";

test("a narrow result table scrolls with the keyboard until its last column is whole", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("phone-320-"), "the width where this table overflows");
  await STATES.find((state) => state.name === "result-table")!.go(page, info);
  const scroll = page.locator(".astryx-table-scroll-wrapper");
  await scroll.focus();
  await scroll.press("ArrowRight");
  await scroll.press("ArrowRight");
  await expect.poll(() => scroll.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const last = element.querySelector("th:last-child")!.getBoundingClientRect();
    return last.left >= box.left - 1 && last.right <= box.right + 1 && element.scrollLeft > 0;
  }), "the full header and amounts are reachable").toBe(true);
});

const WALKS = [
  "flow-list",
  "version",
  "unsent-recordings",
  "setup-participants",
  "setup-microphone-check",
  "setup-required-detail",
  "setup-review-waiting",
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
  "failure-cancelled",
  "review",
  "review-reject",
  "review-text-edit",
  "review-din-version",
  "flow-republish-required",
];

for (const name of WALKS) {
  test(`tab through ${name}`, async ({ page }, info) => {
    const state = STATES.find((s) => s.name === name)!;
    test.skip(state.only ? !state.only(info) : false, "the state does not exist at this width or in this browser");
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

// A page with nothing but its message has two stops, and the second is the way on.
test("K plays and pauses from anywhere on the page, before the player is clicked and from its buttons; the search keeps the letter", async ({ page }, info) => {
  test.skip(!["laptop-1440-light", "laptop-1440-firefox", "laptop-1440-webkit"].includes(info.project.name), "a laptop's keyboard, in each engine");
  await result(page);
  const play = page.getByRole("button", { name: "Spela upp", exact: true });
  const pause = page.getByRole("button", { name: "Pausa uppspelningen" });
  await page.keyboard.press("k");
  await expect(pause, "nothing in the player clicked yet").toBeVisible();
  await page.keyboard.press("k");
  await expect(play).toBeVisible();
  await play.click();
  await expect(pause).toBeVisible();
  await page.keyboard.press("k");
  await expect(play, "with the focus on the player's button").toBeVisible();
  const search = page.getByRole("searchbox", { name: "Sök i transkriberingen" }).or(page.getByRole("textbox", { name: "Sök i transkriberingen" }));
  await search.press("k");
  await expect(search).toHaveValue("k");
  await expect(play, "typed, not played").toBeVisible();
});

test("Escape empties the transcript's search and leaves the focus in it", async ({ page }, info) => {
  test.skip(!["laptop-1440-light", "phone-390-light"].includes(info.project.name), "a laptop's keyboard, and a phone's own");
  await result(page);
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  const search = page.getByRole("searchbox", { name: "Sök i transkriberingen" }).or(page.getByRole("textbox", { name: "Sök i transkriberingen" }));
  await search.fill("budget");
  await expect(page.getByRole("button", { name: "Nästa träff" })).toBeVisible();
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(search, "the focus stays to type another").toBeFocused();
  await expect(page.getByRole("button", { name: "Nästa träff" }), "the count and the arrows go with the query").toHaveCount(0);
});

test("K, J and L are turned off from the line that says them, stay off after a reload, and come back with Slå på", async ({ page }, info) => {
  test.skip(!["laptop-1440-light", "laptop-1440-firefox", "laptop-1440-webkit"].includes(info.project.name), "a laptop's keyboard, in each engine");
  await result(page);
  const play = page.getByRole("button", { name: "Spela upp", exact: true });
  const pause = page.getByRole("button", { name: "Pausa uppspelningen" });
  const turnOff = page.getByRole("button", { name: "Stäng av tangenterna" });
  const turnOn = page.getByRole("button", { name: "Slå på tangenterna" });
  // K pressed where it would act: what it did is drawn by the next frames, so nothing drawn by then is nothing done.
  const pressK = async () => {
    await page.keyboard.press("k");
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  };
  const box = await turnOff.boundingBox();
  expect(Math.min(box?.width ?? 0, box?.height ?? 0), "a 24 px target with a mouse (WCAG 2.5.8)").toBeGreaterThanOrEqual(24);

  // The way past the passages leads to the player, where the line's control is the first stop, its focus in sight.
  await page.getByRole("link", { name: "Hoppa förbi transkriberingen" }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press(tabKey(page));
  await expect(turnOff).toBeFocused();
  const stop = await focusStop(page);
  expect(stopProblems(stop ? [stop] : []), "visible and not covered").toEqual([]);
  await page.keyboard.press("Enter");
  await expect(turnOn, "the focus stays on the control, which now turns them on").toBeFocused();
  await expect(page.getByRole("region", { name: "Inspelning och transkribering" }).getByText("Tangenterna K, J och L är avstängda.")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Tangenterna K, J och L är avstängda." }), "and said").toBeAttached();
  await expect(play, "the button names no key that does nothing").not.toHaveAttribute("aria-keyshortcuts");
  await pressK();
  await expect(pause, "off from the line's own control").toHaveCount(0);

  await page.reload();
  await expect(turnOn, "the choice is kept for this person").toBeVisible();
  await pressK();
  await expect(pause, "off from the page after a reload").toHaveCount(0);
  await turnOn.click();
  await expect(turnOff).toBeVisible();
  await pressK();
  await expect(pause, "on again").toBeVisible();
});

test("on a touch screen no line says K, J and L: they do nothing from the page and act with the focus in the player", async ({ page }, info) => {
  test.skip(
    !["phone-390-light", "tablet-landscape", "phone-390-webkit", "tablet-landscape-webkit"].includes(info.project.name),
    "a phone and a tablet with a keyboard of their own, in Chromium and in Safari's engine",
  );
  await result(page);
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  const play = page.getByRole("button", { name: "Spela upp", exact: true });
  await expect(play).toBeVisible();
  await expect(page.getByRole("button", { name: /tangenterna$/ }), "nothing to turn them off with").toHaveCount(0);
  await expect(play, "the button names no key").not.toHaveAttribute("aria-keyshortcuts");
  // Pressed from the page, where K plays on a laptop: what a key did is drawn by the next frames.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (const key of ["k", "l"]) await page.keyboard.press(key);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await expect(page.getByRole("button", { name: "Pausa uppspelningen" }), "K played nothing").toHaveCount(0);
  await expect(page.getByRole("slider", { name: "Position i inspelningen" }), "L moved nothing").toHaveAttribute("aria-valuenow", "0");
  // With the focus in the player, as a keyboard of the tablet's own puts it there (WCAG 2.1.4: active only on focus).
  await play.focus();
  await page.keyboard.press("k");
  await expect(page.getByRole("button", { name: "Pausa uppspelningen" }), "K from the player plays").toBeVisible();
});

test("Avbryt redigering with a change asks first: Fortsätt redigera gives the focus back to it, Ta bort ändringen to Redigera", async ({ page }, info) => {
  test.skip(!["phone-390-light", "laptop-1440-light"].includes(info.project.name), "a phone and a laptop");
  await STATES.find((s) => s.name === "review-text-changed")!.go(page, info);
  const cancel = page.getByRole("button", { name: "Avbryt redigering" });
  const question = page.getByRole("alertdialog", { name: "Avbryta redigeringen?" });
  await cancel.focus();
  await page.keyboard.press("Enter");
  await expect(question).toBeVisible();
  await question.getByRole("button", { name: "Fortsätt redigera" }).press("Enter");
  await expect(question).toBeHidden();
  await expect(cancel, "nothing thrown away: back where it was").toBeFocused();
  await page.keyboard.press("Enter");
  await question.getByRole("button", { name: "Ta bort ändringen" }).press("Enter");
  await expect(question).toBeHidden();
  await expect(page.getByRole("main").locator("textarea")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Redigera" }), "the control that took the edit's place").toBeFocused();
});

// From a laptop's width the transcript scrolls in its own box. Firefox makes a box that scrolls a Tab stop of its own, but
// gives it no focus: the next Tab after the link before the passages landed on nothing (2.4.7). Its passages' controls are
// the way through it.
test("from the link before the transcript, Tab goes to its first passage's control", async ({ page }, info) => {
  test.skip(!isLaptop(info), "the transcript scrolls in its own box from a laptop's width");
  await result(page);
  await page.getByRole("link", { name: "Hoppa förbi transkriberingen" }).focus();
  await page.keyboard.press(tabKey(page));
  const focused = await page.evaluate(() => {
    const element = document.activeElement!;
    return { tag: element.tagName, name: element.getAttribute("aria-label") ?? element.textContent };
  });
  expect(focused).toEqual({ tag: "BUTTON", name: "Talare 1, ändra talare" });
});

// A refused Skapa dokument moves the focus to the field to mend. Firefox and Safari scroll a focused field only to the
// window's nearest edge, which left the sentence under it (what to mend) behind a phone's docked action.
for (const [state, message] of [["setup-own-count-invalid", "Skriv ett heltal från 1, eller lämna fältet tomt."], ["setup-required-detail", "Fyll i det här för att skapa dokumentet."]] as const) {
  test(`on a phone, the field ${state} moves the focus to has its sentence above the docked action`, async ({ page }, info) => {
    test.skip(!isPhone(info), "the docked action is a phone's");
    await STATES.find((s) => s.name === state)!.go(page, info);
    const sentence = (await page.getByRole("main").getByText(message).boundingBox())!;
    const dock = await page.evaluate(() => {
      const docked = [...document.querySelectorAll<HTMLElement>("*")].find((element) => getComputedStyle(element).position === "sticky" && element.getBoundingClientRect().bottom >= innerHeight - 1 && element.getBoundingClientRect().height > 0);
      return docked ? docked.getBoundingClientRect().top : innerHeight;
    });
    expect(sentence.y + sentence.height, "the sentence ends above the dock").toBeLessThanOrEqual(dock + 0.5);
  });
}

test("tab through flows-unreachable: the skip link, then Försök igen, each with focus visible", async ({ page }, info) => {
  await STATES.find((s) => s.name === "flows-unreachable")!.go(page, info);
  const { stops, left } = await tabWalk(page);
  writeFileSync(info.outputPath("stops.json"), JSON.stringify(stops, null, 2));
  expect(stops.map((stop) => stop.label)).toEqual(['a "Hoppa till innehåll"', 'button "Försök igen"']);
  expect.soft(left, "focus leaves the page after the second stop (WCAG 2.1.2)").toBe(true);
  expect.soft(stopProblems(stops), "focus visible and unobscured").toEqual([]);
});

// The docked action of a phone grows with its words and with the spacing a reader may set (WCAG 1.4.12): focus must
// still stop above it, whatever its height is.
for (const name of ["setup", "setup-participants", "setup-microphone-check"]) {
  test(`tab through ${name} with the text spacing a reader may set`, async ({ page }, info) => {
    test.skip(!isPhone(info), "the docked action is a phone's");
    await STATES.find((s) => s.name === name)!.go(page, info);
    await addStyles(page, TEXT_SPACING);
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

// APG permits initial focus on the static title to announce a dialog's beginning. It is not a keyboard control.
const focusedTitle = (popup: Locator) => popup.evaluate((element) => {
  const focused = document.activeElement;
  return focused instanceof HTMLElement && /^H[1-6]$/.test(focused.tagName) && focused.tabIndex === -1
    && element.getAttribute("aria-labelledby")?.split(/\s+/).includes(focused.id);
});

/**
 * Puts the focus on a control as a keyboard does: there by script, then one stop back and forward again with the keys.
 * Firefox draws the ring on the focus that a script moves next (into the dialog that opens) only when a key moved the
 * focus last, not a script, and not the mouse that set the state up.
 */
async function arrive(page: Page, control: Locator) {
  await control.focus();
  await page.keyboard.press(tabKey(page, true));
  await page.keyboard.press(tabKey(page));
  await expect(control, "the keys bring the focus back to the control").toBeFocused();
}

/** Opens a dialog or menu from its trigger with Enter, keeps Tab inside it, and closes it with Escape. */
async function holdsFocus(page: Page, trigger: Locator, popup: Locator, tabs = 4) {
  await arrive(page, trigger);
  await page.keyboard.press("Enter");
  await expect(popup).toBeVisible();
  await settle(page);
  // Escape cannot reach the dialog from inside a frame (the PDF viewer), so focus must not start there.
  expect.soft(await page.evaluate(() => document.activeElement?.tagName), "focus starts on the dialog's own controls").not.toBe("IFRAME");
  const problems: string[] = [];
  const keys = [...Array(tabs).fill(tabKey(page)), ...Array(Math.min(tabs, 2)).fill(tabKey(page, true))];
  for (let i = 0; i <= keys.length; i++) {
    if (!(await inBrowser(page))) {
      // At rest: the tooltip of the control that has the focus enters over a few frames, and in them overlaps it.
      await settle(page);
      const stop = await focusStop(page);
      const inside = await popup.evaluate((element) => element.contains(document.activeElement));
      if (!stop || !inside) problems.push(`${stop?.label ?? "the page"} is outside the ${await popup.getAttribute("role")}`);
      else {
        const startsOnTitle = i === 0 && await focusedTitle(popup);
        problems.push(...stopProblems([startsOnTitle ? { ...stop, indicator: true } : stop]));
      }
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

test("a cancel Eneo refuses gives the focus back to Avbryt körningen, under the refusal", async ({ page, sentinel }, info) => {
  test.skip(info.project.name !== "laptop-1440-light", "focus after a refusal, at one width");
  sentinel.expect({ console: /status of 409.*\/cancel\// });
  await page.route("**/cancel/", (route) => route.fulfill({ status: 409, json: { code: "flow_run_not_cancellable" } }));
  await run(page, ids.runs.running);
  const trigger = page.getByRole("button", { name: "Avbryt körningen" });
  await trigger.click();
  await page.getByRole("alertdialog", { name: "Avbryta körningen?" }).getByRole("button", { name: "Avbryt körningen" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(trigger, "the button that asked, not the page's body").toBeFocused();
});

// A page cannot hear Escape while focus is inside the browser's PDF viewer. The viewer either is no Tab stop (its
// content is a link away, in a tab of its own), or Tab leads out of it back to the dialog's own controls (WCAG
// 2.1.2). From those controls, Escape closes the dialog.
test("the PDF preview holds focus, never traps it in the viewer, and Escape closes it from the dialog", async ({ page }, info) => {
  test.skip(!pdfInDialog(info), "below a laptop's width, and on a touch screen, the PDF opens in a new tab");
  await run(page, ids.runs.done);
  const trigger = page.getByRole("button", { name: /^Öppna Protokoll .*\.pdf$/ });
  const dialog = page.getByRole("dialog");
  await arrive(page, trigger);
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
      else {
        const startsOnTitle = presses === 0 && await focusedTitle(dialog);
        problems.push(...stopProblems([startsOnTitle ? { ...stop, indicator: true } : stop]));
      }
      leftFrame = frame !== null;
      // Back at a stop already met, without meeting the viewer: Tab goes round the dialog's own controls.
      const key = stop ? `${stop.label}@${stop.left},${stop.top}` : "";
      cycled = seen.has(key);
      seen.add(key);
    }
    if (!leftFrame && !cycled) {
      await page.keyboard.press(tabKey(page));
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
  // The walk can end on a control whose tooltip is up (the close button, where Tab has nowhere to go on to, as in
  // Firefox): that tooltip takes the first Escape (WCAG 1.4.13), and the next one is the dialog's.
  await settle(page);
  const tooltip = page.getByRole("tooltip");
  if (await tooltip.count()) {
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
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
  await page.keyboard.press(tabKey(page));
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
    await page.keyboard.press(tabKey(page));
  }
  expect.soft(problems, "focus stays inside and is visible (WCAG 2.1.2, 2.4.7)").toEqual([]);
  expect([...reached]).toEqual(expect.arrayContaining(['button "Pausa"', 'button "Stoppa"', 'button "Logga in igen"']));
});

test("the naming dialog holds focus and gives it back", async ({ page }, info) => {
  await STATES.find((s) => s.name === "review")!.go(page, info);
  await holdsFocus(page, page.getByRole("button", { name: "Namnge talarna" }), page.getByRole("dialog", { name: "Namnge talarna" }));
});

test("the naming dialog after the run holds focus and gives it back", async ({ page }, info) => {
  await STATES.find((s) => s.name === "result")!.go(page, info);
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  await holdsFocus(page, page.getByRole("button", { name: "Namnge talare" }), page.getByRole("dialog", { name: "Namnge talarna" }));
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
  await page.keyboard.press(tabKey(page));
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
  for (const key of [tabKey(page), tabKey(page), tabKey(page, true), tabKey(page)]) {
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
  // Two named microphones, so the arrow has somewhere to go. The engines' own differ: Chromium's fake devices are three
  // with their names, WebKit's and Firefox's one, named only once a recording has been allowed.
  await page.addInitScript(() => {
    MediaDevices.prototype.enumerateDevices = async () =>
      ["Inbyggd mikrofon", "Headset"].map((label, index) => ({ kind: "audioinput", deviceId: `mikrofon-${index}`, groupId: `grupp-${index}`, label, toJSON: () => ({}) }) as MediaDeviceInfo);
  });
  await setup(page);
  await chooseMode(page, "Spela in");
  // The pointer off where the list opens: an option under it is the active one, which the keyboard would then start from.
  await page.mouse.move(0, 0);
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
  needsRecording();
  await setup(page);
  const cards = page.getByRole("radio");
  await page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" }).focus();
  await page.keyboard.press(tabKey(page));
  await expect(cards.first(), "Tab reaches the chosen mode").toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(cards.nth(1)).toBeFocused();
  await expect(cards.nth(1), "the arrow key chooses the mode it moves to").toBeChecked();
});

test("participants are added and removed from the keyboard", async ({ page }) => {
  await setup(page);
  await chooseMode(page, "Spela in");
  const input = page.getByRole("textbox", { name: /^Deltagare/ });
  await input.focus();
  await page.keyboard.type("Anna Berg");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Erik Lund,");
  await expect(page.getByRole("button", { name: "Ta bort Erik Lund" })).toBeVisible();
  await page.keyboard.press("Backspace");
  await expect(page.getByRole("button", { name: "Ta bort Erik Lund" })).toBeHidden();
  // The names follow the field, and "Lägg till" is off while nothing is typed: Tab passes it to the first name's button.
  await page.keyboard.press(tabKey(page));
  await expect(page.getByRole("button", { name: "Ta bort Anna Berg" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Ta bort Anna Berg" })).toBeHidden();
  await expect(input, "removing a name keeps focus in the field").toBeFocused();
});

test("Antal talare keeps what was typed: a letter is an error the start sends focus back to", async ({ page, browserName }) => {
  await setup(page);
  await chooseMode(page, "Spela in");
  await page.getByRole("switch", { name: "Märk upp talare" }).click();
  const count = page.getByRole("textbox", { name: /^Antal talare/ });
  await count.focus();
  // A number field would read "e" as empty and let the run start without a count.
  await page.keyboard.type("e");
  await expect(count).toHaveValue("e");
  await expect(count).toHaveAttribute("aria-invalid", "true");
  // The description as the browser's own tree has it, where the gate can read that tree (Chromium, over the DevTools
  // protocol); elsewhere as the markup gives it.
  if (browserName === "chromium") expect((await axNode(count)).description).toContain("Skriv ett heltal från 1 till 20, eller lämna fältet tomt.");
  else await expect(count).toHaveAccessibleDescription(/Skriv ett heltal från 1 till 20, eller lämna fältet tomt\./);
  await page.getByRole("button", { name: "Starta inspelning" }).click();
  await expect(count, "the start is refused and the field takes focus").toBeFocused();
  await expect(page.getByRole("button", { name: "Stoppa" })).toHaveCount(0);
});

test("the input modes are one Tab stop: every arrow moves and chooses, round the ends, the setup follows, Tab leaves", async ({ page, browserName }) => {
  needsRecording();
  await setup(page);
  const cards = page.getByRole("radio");
  await expect(cards).toHaveCount(3);
  const ACTION = ["Starta strömning", "Starta inspelning", "Välj ljudfil"];
  const primary = page.getByRole("button", { name: new RegExp(`^(${ACTION.join("|")})$`) });
  // A chosen mode other than the first: Tab enters the group where the choice is, not at its top.
  await cards.nth(1).click();
  await page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" }).focus();
  await page.keyboard.press(tabKey(page));
  await expect(cards.nth(1), "Tab enters at the chosen mode").toBeFocused();
  // The modes are native radios. Chromium and Firefox take an arrow round the ends of a radio group; in WebKit an arrow at
  // an end stays there, as it does in every radio group of that engine, so there the walk turns back.
  const round = [["ArrowDown", 2], ["ArrowDown", 0], ["ArrowUp", 2], ["ArrowLeft", 1], ["ArrowRight", 2], ["ArrowRight", 0]] as const;
  const toTheEnds = [["ArrowDown", 2], ["ArrowDown", 2], ["ArrowUp", 1], ["ArrowLeft", 0], ["ArrowUp", 0], ["ArrowRight", 1], ["ArrowRight", 2], ["ArrowLeft", 1], ["ArrowUp", 0]] as const;
  for (const [key, to] of browserName === "webkit" ? toTheEnds : round) {
    await page.keyboard.press(key);
    await expect(cards.nth(to), `${key} moves focus to mode ${to + 1}`).toBeFocused();
    await expect(cards.nth(to), `${key} chooses mode ${to + 1}`).toBeChecked();
    await expect(primary, "the start action follows the chosen mode").toHaveText(ACTION[to]);
  }
  await expect(page.getByRole("button", { name: "Testa mikrofonen" }), "Strömma's own setup shows").toBeVisible();
  await page.keyboard.press(tabKey(page));
  expect(await page.evaluate(() => document.activeElement?.getAttribute("role")), "the next Tab leaves the group").not.toBe("radio");
  // The microphone stands right under the way that records with it, before the speaker controls.
  await expect(page.getByRole("combobox", { name: "Mikrofon" })).toBeFocused();
});
