/**
 * While the login has ended, nothing of the page is shown or within reach: not the page, and not a dialog the page
 * had open. Proved in the browser as a person meets it (what is visible, what takes focus, what the accessibility
 * tree holds), because a modal dialog leaves an inert ancestor's inertness and an attribute cannot show that.
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./gate";
import { chooseMode, endLogin, isLaptop, record, result, run, sessionWarning, setup, setupFromList, stop } from "./screens";
import ids from "../fixtures/ids.json";

test.beforeEach(({}, info) => test.skip(!["laptop-1440-light", "phone-390-light"].includes(info.project.name), "two widths are enough"));

const signIn = { name: "Du behöver logga in igen" };

/**
 * Where Tab can go while a modal dialog is open: onto its own controls, or out of the page to the browser's (the
 * document then has no focus: a native dialog is no focus trap, WCAG 2.1.2). Never onto the page behind it.
 */
const notBehind = (page: Page) =>
  page.evaluate(() => !document.hasFocus() || document.activeElement?.closest('[role="alertdialog"]') != null);

/** Focus never reaches the page, however far Tab goes: it stays in the sign-in dialog or goes to the browser's controls. */
async function tabStaysInSignIn(page: Page) {
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await notBehind(page), `Tab ${i + 1}`).toBe(true);
  }
}

test("a page dialog open when the login ends is covered with the page, and is back with its edit after the new login", async ({ page }) => {
  await run(page, ids.runs.review, ids.flows.flow2);
  await expect(page.getByRole("button", { name: /^Spela från/ }).first()).toBeVisible();
  await page.getByRole("button", { name: "Namnge talarna" }).click();
  const naming = page.getByRole("dialog", { name: "Namnge talarna" });
  const name = naming.getByLabel(/^Vem är Talare 1/);
  await name.fill("Zara Testsson");

  await endLogin(page);
  await expect(naming, "the page's dialog is not shown, nor in the accessibility tree").toBeHidden();
  // What a screen reader is given holds the sign-in dialog, whole, and nothing of the page.
  const tree = await page.locator("body").ariaSnapshot();
  expect(tree).toContain('heading "Du behöver logga in igen"');
  expect(tree).toContain('button "Logga in igen"');
  expect(tree).not.toMatch(/Namnge talarna|Vem är vem|Zara Testsson/);
  await tabStaysInSignIn(page);

  // The same person signs in again (here: the session answers again, and the page asks when it becomes visible).
  await page.unroute("**/api/auth/status");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("alertdialog", signIn)).toBeHidden();
  await expect(naming).toBeVisible();
  await expect(name).toHaveValue("Zara Testsson");
});

test("a name list open when the login ends goes with its dialog, and the focus is inside the dialog again after the new login", async ({ page }) => {
  await run(page, ids.runs.review, ids.flows.flow2);
  await expect(page.getByRole("button", { name: /^Spela från/ }).first()).toBeVisible();
  await page.getByRole("button", { name: "Namnge talarna" }).click();
  const naming = page.getByRole("dialog", { name: "Namnge talarna" });
  await naming.getByLabel(/^Vem är Talare 1/).click();
  const list = page.getByRole("listbox", { name: /^Förslag: Vem är Talare 1/ });
  await expect(list).toBeVisible();

  await endLogin(page);
  await expect(naming).toBeHidden();
  await expect(list, "a list of the page is covered with its dialog").toBeHidden();

  await page.unroute("**/api/auth/status");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(naming).toBeVisible();
  await expect(list, "the list does not come back by itself").toBeHidden();
  expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null), "focus is in the dialog").toBe(true);
});

test("a change-speaker popover open when the login ends is covered with the page, and the page works after the new login", async ({ page }) => {
  await run(page, ids.runs.review, ids.flows.flow2);
  await expect(page.getByRole("button", { name: /^Spela från/ }).first()).toBeVisible();
  const trigger = page.getByRole("button", { name: "Anna Berg, ändra talare" }).first();
  await trigger.click();
  const picker = page.getByRole("dialog", { name: "Ändra talare" });
  await expect(picker).toBeVisible();

  await endLogin(page);
  // Not a modal: it is part of the page, so the cover's inertness reaches it, though it is in the top layer.
  await expect(picker).toBeHidden();
  expect(await page.locator("body").ariaSnapshot()).not.toMatch(/Ändra talare|Anna Berg/);

  await page.unroute("**/api/auth/status");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("alertdialog", signIn)).toBeHidden();
  await expect(trigger).toBeVisible();
});

test("the warning already open when the login ends becomes the sign-in dialog, which nothing but a new login closes", async ({ page }) => {
  await sessionWarning(page);
  await endLogin(page);
  const dialog = page.getByRole("alertdialog", signIn);
  await expect(dialog.getByRole("button", { name: "Stäng" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  // Nor does a click beside it, on the backdrop.
  await page.mouse.click(2, 2);
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("link", { name: /Nämndmöte till rapport/ })).toBeHidden();
});

test("the warning before the end closes with Escape, not with a click beside it", async ({ page }) => {
  await sessionWarning(page);
  const warning = page.getByRole("alertdialog", { name: "Du loggas snart ut" });
  await page.mouse.click(2, 2);
  await expect(warning, "a stray click does not take the only notice away").toBeVisible();
  await page.keyboard.press("Escape");
  await expect(warning).toBeHidden();
});

/** How many pixels of what is on the screen are this exact colour: what of a coloured probe shows. */
async function pixelsOf(page: Page, [r, g, b]: [number, number, number]) {
  const png = (await page.screenshot()).toString("base64");
  return page.evaluate(
    async ([png, r, g, b]) => {
      // Decoded from its bytes: a data: URL would be an image the page's policy does not allow.
      const image = await createImageBitmap(new Blob([Uint8Array.from(atob(png), (character) => character.charCodeAt(0))], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, image.width, image.height).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (Math.abs(data[i] - r) < 8 && Math.abs(data[i + 1] - g) < 8 && Math.abs(data[i + 2] - b) < 8) count++;
      }
      return count;
    },
    [png, r, g, b] as const,
  );
}

test("a native dialog the page had open when the login ends is hidden behind the sign-in dialog, out of reach and out of the accessibility tree", async ({ page }) => {
  await setup(page);
  // What a dialog of the page is, as far as the cover can tell: a native modal dialog inside the page's own subtree,
  // here in a colour nothing else on the screen has, so that any pixel of it that shows is found.
  const MAGENTA: [number, number, number] = [255, 0, 255];
  await page.evaluate(() => {
    const probe = document.createElement("dialog");
    probe.setAttribute("aria-label", "Sidans dialog");
    probe.style.cssText = "background: rgb(255, 0, 255); border: 0; padding: 0; width: 70vw; height: 60vh;";
    probe.innerHTML = '<button type="button" id="page-dialog-button">Sidans knapp</button>';
    document.querySelector('[role="main"]')!.append(probe);
    probe.showModal();
  });
  expect(await pixelsOf(page, MAGENTA), "the probe shows while the login lasts").toBeGreaterThan(1_000);

  await endLogin(page);
  expect(await pixelsOf(page, MAGENTA), "nothing of it shows through the backdrop").toBe(0);
  const reached = await page.evaluate(() => {
    const button = document.getElementById("page-dialog-button")!;
    button.focus();
    return document.activeElement === button;
  });
  expect(reached, "its button cannot take focus").toBe(false);
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    expect(await notBehind(page), `Tab ${i + 1}`).toBe(true);
  }
  const tree = await page.locator("body").ariaSnapshot();
  expect(tree).toContain("Du behöver logga in igen");
  expect(tree).not.toMatch(/Sidans dialog|Sidans knapp/);

  // The same person signs in again: the sign-in dialog goes and the page's own is back as it was.
  await page.unroute("**/api/auth/status");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("alertdialog", signIn)).toBeHidden();
  expect(await pixelsOf(page, MAGENTA), "the page's dialog is back").toBeGreaterThan(1_000);
});

test("Back after the login ended asks above the sign-in dialog, in reach, and answering leaves the sign-in dialog where it was", async ({ page }) => {
  await setupFromList(page);
  await record(page, "Spela in");
  await endLogin(page);
  const sign = page.getByRole("alertdialog", signIn);
  await page.goBack();
  const question = page.getByRole("alertdialog", { name: "Lämna sidan?" });
  await expect(question).toBeVisible();
  await expect(question.getByRole("button", { name: "Stanna kvar" }), "staying has the focus").toBeFocused();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    // The question's own controls or the browser's, never the sign-in dialog under it and never the page.
    expect(await question.evaluate((element) => !document.hasFocus() || element.contains(document.activeElement)), `Tab ${i + 1}`).toBe(true);
  }
  // Escape answers the question and leaves the one under it.
  await page.keyboard.press("Escape");
  await expect(question).toBeHidden();
  await expect(sign).toBeVisible();
  await expect(sign.getByRole("heading", signIn), "focus is back where it was: in the sign-in dialog").toBeFocused();
  // It asks again for as long as the page holds work, and nothing but a new login closes the dialog under it.
  await page.goBack();
  await expect(question).toBeVisible();
  await question.getByRole("button", { name: "Stanna kvar" }).click();
  await expect(question).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(sign).toBeVisible();
});

test("the leave question opens above the warning that came while recording, and answering it gives the warning back", async ({ page }) => {
  // The warning opens five minutes before the end: here a few seconds into a recording.
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({
      json: { authenticated: true, user: { id: "user-1", email: "erik.lund@sundsvall.se", username: "Erik Lund" }, session_ends_in: 305 },
    }),
  );
  await setupFromList(page);
  await record(page, "Spela in");
  const warning = page.getByRole("alertdialog", { name: "Du loggas snart ut" });
  await expect(warning).toBeVisible({ timeout: 15_000 });
  await page.goBack();
  const question = page.getByRole("alertdialog", { name: "Lämna sidan?" });
  await expect(question).toBeVisible();
  await question.getByRole("button", { name: "Stanna kvar" }).click();
  await expect(question).toBeHidden();
  await expect(warning, "the warning is where it was").toBeVisible();
  await expect(warning.getByRole("heading", { name: "Du loggas snart ut" }), "and has the focus").toBeFocused();
});

test("someone else signing in leaves the page covered, and the dialog says whom to sign in as", async ({ page }) => {
  await setup(page);
  await endLogin(page);
  await page.unroute("**/api/auth/status");
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({
      json: { authenticated: true, user: { id: "user-2", email: "sara.holm@sundsvall.se", username: "Sara Holm" }, session_ends_in: 3600 },
    }),
  );
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const dialog = page.getByRole("alertdialog", signIn);
  await expect(dialog).toContainText("Du är inloggad som Sara Holm. Logga in som Erik Lund för att fortsätta.");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" })).toBeHidden();
});

test("the new login in a window of its own gives the page and the focus back", async ({ page, context }) => {
  await setup(page);
  const mode = page.getByRole("radio", { name: /^Spela in/ });
  await mode.focus();
  await endLogin(page);
  const logins: string[] = [];
  // Eneo's handoff, as a signed-in browser gets it: straight back to the page the login asked for.
  await context.route("**/api/auth/login?*", (route) => {
    const url = new URL(route.request().url());
    logins.push(url.search);
    return route.fulfill({ status: 303, headers: { location: url.searchParams.get("next") ?? "/flows" } });
  });
  // The window signs in; the session then answers as a signed-in one.
  await page.unroute("**/api/auth/status");
  const popup = context.waitForEvent("page");
  await page.getByRole("alertdialog", signIn).getByRole("button", { name: "Logga in igen" }).click();
  await (await popup).waitForEvent("close");
  await expect(page.getByRole("alertdialog", signIn)).toBeHidden();
  expect(logins, "after the end it is a new login, not a renewal bound to a user").toEqual(["?next=%2Finloggad"]);
  await expect(page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" })).toBeVisible();
  await expect(mode, "focus is back where it was on the page").toBeFocused();
});

test("signed out, a recording is stopped from the sign-in dialog, and is done when the page is back", async ({ page }) => {
  await setup(page);
  await record(page, "Spela in");
  await endLogin(page);
  const dialog = page.getByRole("alertdialog", signIn);
  await dialog.getByRole("button", { name: "Stoppa" }).click();
  await expect(dialog.getByRole("button", { name: "Stoppa" }), "nothing to stop once it is done").toHaveCount(0);
  await expect(dialog, "and the page is still covered").toBeVisible();
  await page.unroute("**/api/auth/status");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: "Inspelningen är klar" })).toBeVisible();
});

test("the leave question can be answered with a mouse while the delete question is open under it", async ({ page }) => {
  await setupFromList(page);
  await record(page, "Spela in");
  await page.getByRole("button", { name: "Stoppa" }).click();
  await page.getByRole("button", { name: "Ta bort" }).click();
  const deleting = page.getByRole("alertdialog", { name: "Ta bort inspelningen?" });
  await expect(deleting).toBeVisible();

  await page.goBack();
  const question = page.getByRole("alertdialog", { name: "Lämna sidan?" });
  await expect(question).toBeVisible();
  await question.getByRole("button", { name: "Stanna kvar" }).click();
  await expect(question).toBeHidden();
  await expect(deleting, "the page's own question is as it was").toBeVisible();
});

test("the sign-in button answers a mouse while a dialog of the page was open when the login ended, and the edit in that dialog is kept", async ({ page, context }) => {
  await run(page, ids.runs.review, ids.flows.flow2);
  await expect(page.getByRole("button", { name: /^Spela från/ }).first()).toBeVisible();
  await page.getByRole("button", { name: "Namnge talarna" }).click();
  const naming = page.getByRole("dialog", { name: "Namnge talarna" });
  const name = naming.getByLabel(/^Vem är Talare 1/);
  await name.fill("Zara Testsson");

  await endLogin(page);
  const tree = await page.locator("body").ariaSnapshot();
  expect(tree).toContain('heading "Du behöver logga in igen"');
  expect(tree).toContain('button "Logga in igen"');
  const popup = context.waitForEvent("page");
  await page.getByRole("alertdialog", signIn).getByRole("button", { name: "Logga in igen" }).click();
  await (await popup).close();

  await page.unroute("**/api/auth/status");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("alertdialog", signIn)).toBeHidden();
  await expect(naming).toBeVisible();
  await expect(name).toHaveValue("Zara Testsson");
});

test("the cancel question open when the login ends is covered with the page, and is back after the new login", async ({ page }) => {
  await run(page, ids.runs.running);
  const trigger = page.getByRole("button", { name: "Avbryt körningen" });
  await trigger.click();
  const question = page.getByRole("alertdialog", { name: "Avbryta körningen?" });
  await expect(question).toBeVisible();

  await endLogin(page);
  await expect(question, "a native dialog would stay above the covered page").toBeHidden();
  const tree = await page.locator("body").ariaSnapshot();
  expect(tree).toContain("Du behöver logga in igen");
  expect(tree).not.toMatch(/Avbryta körningen|Dokumentet skapas/);
  await tabStaysInSignIn(page);

  await page.unroute("**/api/auth/status");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("alertdialog", signIn)).toBeHidden();
  await expect(question, "still asked, as it was").toBeVisible();
  await page.keyboard.press("Escape");
  await expect(question).toBeHidden();
  await expect(trigger, "Escape gives the focus back to what opened it, also across the new login").toBeFocused();
});

// The PDF preview is a page dialog like the naming dialog, with a viewer in it that must not be reloaded by the cover.
test("the PDF preview open when the login ends is covered with the page, and is back with its viewer after the new login", async ({ page }, info) => {
  test.skip(!isLaptop(info), "below a laptop's width the PDF opens in a tab of its own");
  await result(page);
  await page.getByRole("button", { name: /^Öppna Protokoll .*\.pdf$/ }).click();
  const preview = page.getByRole("dialog", { name: /^Protokoll .*\.pdf$/ });
  await expect(preview.locator("iframe")).toBeVisible();

  await endLogin(page);
  await expect(preview, "the preview is not shown, nor in the accessibility tree").toBeHidden();
  const tree = await page.locator("body").ariaSnapshot();
  expect(tree).toContain("Du behöver logga in igen");
  expect(tree).not.toMatch(/Protokoll kommunstyrelsen|Öppna i ny flik|Ladda ner/);
  await tabStaysInSignIn(page);

  await page.unroute("**/api/auth/status");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("alertdialog", signIn)).toBeHidden();
  await expect(preview).toBeVisible();
  await expect(preview.locator("iframe")).toHaveAttribute("src", /disposition=inline/);
});

test("the delete question open when the login ends is covered with the page, and is back after the new login", async ({ page }) => {
  await setup(page);
  await record(page, "Spela in");
  await stop(page);
  const trigger = page.getByRole("button", { name: "Ta bort", exact: true });
  await trigger.click();
  const question = page.getByRole("alertdialog", { name: "Ta bort inspelningen?" });
  await expect(question).toBeVisible();

  await endLogin(page);
  await expect(question, "a native dialog would stay above the covered page").toBeHidden();
  const tree = await page.locator("body").ariaSnapshot();
  expect(tree).toContain("Du behöver logga in igen");
  expect(tree).not.toMatch(/Ta bort inspelningen|Den går inte att få tillbaka/);
  await tabStaysInSignIn(page);

  await page.unroute("**/api/auth/status");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("alertdialog", signIn)).toBeHidden();
  await expect(question, "still asked, as it was").toBeVisible();
  await page.keyboard.press("Escape");
  await expect(question).toBeHidden();
  await expect(trigger, "Escape gives the focus back to what opened it, also across the new login").toBeFocused();
});

test("the microphone list open when the login ends is covered with the page, and is not in the accessibility tree", async ({ page }) => {
  await setup(page);
  await chooseMode(page, "Spela in");
  const picker = page.getByRole("combobox", { name: "Mikrofon" });
  await picker.click();
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();

  await endLogin(page);
  await expect(list, "a list in the top layer must not stay above the covered page").toBeHidden();
  const tree = await page.locator("body").ariaSnapshot();
  expect(tree).toContain("Du behöver logga in igen");
  expect(tree).not.toMatch(/Mikrofon|Fake Default Audio Input/);
  await tabStaysInSignIn(page);
});

test("the sign-in dialog stays a modal when something closes it, and goes with the new login", async ({ page }) => {
  await setup(page);
  await endLogin(page);
  const dialog = page.getByRole("alertdialog", signIn);
  const modal = () => dialog.evaluate((element) => element.matches(":modal"));
  // A second close request without a new user action (Android's back is one) closes a dialog that no handler can
  // keep: what is left is an open box that is no modal. It is opened as a modal again, the focus in it.
  for (let request = 1; request <= 2; request++) {
    await dialog.evaluate((element) => (element as HTMLDialogElement).close());
    await expect.poll(modal, `after close request ${request}`).toBe(true);
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((element) => element.contains(document.activeElement)), "focus is in it").toBe(true);
  }
  expect(await page.evaluate(() => document.querySelector("main")?.closest("[inert]") !== null), "the page is out of reach").toBe(true);

  // With the new login it goes, and stays gone.
  await page.unroute("**/api/auth/status");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(dialog).toBeHidden();
  await page.waitForTimeout(300);
  expect(await page.locator("dialog[open]").count(), "nothing opens it again").toBe(0);
});

// A 400 % zoom of a 1280 x 800 window is 320 x 200 CSS pixels; 256 is a phone held sideways under its browser's bars.
for (const height of [256, 200]) {
  test(`at 320 x ${height} the sign-in dialog and the recording's controls are each usable, with no scrolling in two directions`, async ({ page }) => {
    await setup(page);
    await record(page, "Spela in");
    await page.setViewportSize({ width: 320, height });
    await endLogin(page);
    const dialog = page.getByRole("alertdialog", signIn);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "horizontal scroll (WCAG 1.4.10)").toBe(true);
    const box = (await dialog.boundingBox())!;
    expect(box.y >= 0 && box.y + box.height <= height && box.x >= 0 && box.x + box.width <= 320, "the dialog is within the screen").toBe(true);
    // What does not fit scrolls, as a whole: not a strip of a few lines inside it.
    const strips = await dialog.evaluate((element) =>
      [element, ...element.querySelectorAll<HTMLElement>("*")]
        .filter((e) => e.scrollHeight > e.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(e).overflowY))
        .map((e) => e.clientHeight),
    );
    for (const shown of strips) expect(shown, `a scroller that shows ${shown} px of a ${height} px screen`).toBeGreaterThanOrEqual(height * 0.6);
    // Each part is whole in view once it has the focus, and the title and the first lines at the top.
    await expect(dialog.getByRole("heading", signIn)).toBeInViewport({ ratio: 1 });
    for (const name of ["Pausa", "Stoppa", "Logga in igen"]) {
      const button = dialog.getByRole("button", { name });
      await button.focus();
      await expect(button, name).toBeInViewport({ ratio: 1 });
      const rect = (await button.boundingBox())!;
      expect(rect.height, `${name} is as high as ever`).toBeGreaterThanOrEqual(24);
    }
  });
}

// Every dialog of the page that exists today, with what must be as it was when it comes back: the login ends under it,
// the person clicks the sign-in dialog and presses Escape (which a required dialog ignores, and the dialog under it
// must not hear), signs in again, and the page's dialog is there with what was in it.
const PAGE_DIALOGS: { name: string; only?: (laptop: boolean) => boolean; open: (page: Page) => Promise<{ dialog: ReturnType<Page["locator"]>; kept: () => Promise<unknown> }> }[] = [
  {
    name: "the speaker naming dialog, with an edit in it",
    open: async (page) => {
      await run(page, ids.runs.review, ids.flows.flow2);
      await expect(page.getByRole("button", { name: /^Spela från/ }).first()).toBeVisible();
      await page.getByRole("button", { name: "Namnge talarna" }).click();
      const dialog = page.getByRole("dialog", { name: "Namnge talarna" });
      const field = dialog.getByLabel(/^Vem är Talare 1/);
      await field.fill("Zara Testsson");
      return { dialog, kept: () => expect(field).toHaveValue("Zara Testsson") };
    },
  },
  {
    name: "the delete question",
    open: async (page) => {
      await setup(page);
      await record(page, "Spela in");
      await stop(page);
      await page.getByRole("button", { name: "Ta bort", exact: true }).click();
      const dialog = page.getByRole("alertdialog", { name: "Ta bort inspelningen?" });
      await expect(dialog).toBeVisible();
      return { dialog, kept: () => expect(dialog.getByRole("button", { name: "Behåll" }).or(dialog.getByRole("button", { name: "Avbryt" })).first()).toBeVisible() };
    },
  },
  {
    name: "the cancel question",
    open: async (page) => {
      await run(page, ids.runs.running);
      await page.getByRole("button", { name: "Avbryt körningen" }).click();
      const dialog = page.getByRole("alertdialog", { name: "Avbryta körningen?" });
      await expect(dialog).toBeVisible();
      return { dialog, kept: () => expect(dialog.getByRole("button", { name: "Kör vidare" })).toBeVisible() };
    },
  },
  {
    name: "the PDF preview, with its viewer",
    only: (laptop) => laptop,
    open: async (page) => {
      await result(page);
      await page.getByRole("button", { name: /^Öppna Protokoll .*\.pdf$/ }).click();
      const dialog = page.getByRole("dialog", { name: /^Protokoll .*\.pdf$/ });
      await expect(dialog.locator("iframe")).toBeVisible();
      return { dialog, kept: () => expect(dialog.locator("iframe")).toHaveAttribute("src", /disposition=inline/) };
    },
  },
];

for (const { name, only, open: openDialog } of PAGE_DIALOGS) {
  test(`${name} coexists with the sign-in dialog: a click and Escape on it change nothing, and it is back as it was after the new login`, async ({ page }, info) => {
    test.skip(!(only?.(isLaptop(info)) ?? true), "below a laptop's width this is a tab of its own");
    const { dialog, kept } = await openDialog(page);

    await endLogin(page);
    const signInDialog = page.getByRole("alertdialog", signIn);
    await expect(dialog).toBeHidden();
    await signInDialog.getByRole("heading", signIn).click();
    await page.keyboard.press("Escape");
    await expect(signInDialog, "Escape does not close the sign-in dialog").toBeVisible();
    await expect(dialog, "and what is under it stays out of reach").toBeHidden();

    await page.unroute("**/api/auth/status");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(signInDialog).toBeHidden();
    await expect(dialog, "the page's dialog is back: the Escape pressed on the sign-in dialog did not close it").toBeVisible();
    await kept();
  });
}
