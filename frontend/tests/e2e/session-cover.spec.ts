/**
 * While the login has ended, nothing of the page is shown or within reach: not the page, and not a dialog the page
 * had open. Proved in the browser as a person meets it (what is visible, what takes focus, what the accessibility
 * tree holds), because a modal dialog leaves an inert ancestor's inertness and an attribute cannot show that.
 */
import { expect, test, type Page } from "@playwright/test";
import { clippedFocus } from "./checks";
import { endLogin, open, record, run, sessionWarning, setup } from "./screens";

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
  await run(page, "run-review", "flow-2");
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
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
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
  // What a ported page dialog is, as far as the cover can tell: a native modal dialog inside the page's own subtree,
  // here in a colour nothing else on the screen has, so that any pixel of it that shows is found.
  const MAGENTA: [number, number, number] = [255, 0, 255];
  await page.evaluate(() => {
    const probe = document.createElement("dialog");
    probe.setAttribute("aria-label", "Sidans dialog");
    probe.style.cssText = "background: rgb(255, 0, 255); border: 0; padding: 0; width: 70vw; height: 60vh;";
    probe.innerHTML = '<button type="button" id="page-dialog-button">Sidans knapp</button>';
    document.querySelector("main")!.append(probe);
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
  await setup(page);
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
  // It asks again as long as the page is guarded, and nothing but a new login closes the dialog under it.
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
      json: { authenticated: true, auth_mode: "eneo_sso", user: { id: "user-1", email: "erik.lund@sundsvall.se", username: "Erik Lund" }, session_ends_in: 305 },
    }),
  );
  await setup(page);
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
      json: { authenticated: true, auth_mode: "eneo_sso", user: { id: "user-2", email: "sara.holm@sundsvall.se", username: "Sara Holm" }, session_ends_in: 3600 },
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

test("with the access code, signed out, the code is entered in the dialog and the page comes back", async ({ page }) => {
  let signedIn = true;
  const answer = () => ({ authenticated: signedIn, auth_mode: "access_code", user: null, ...(signedIn ? { session_ends_in: 3600 } : {}) });
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: answer() }));
  await open(page, "/flows/flow-1");
  const setupHeading = page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" });
  await expect(setupHeading).toBeVisible();
  signedIn = false;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const dialog = page.getByRole("alertdialog", signIn);
  await expect(dialog).toBeVisible();
  const code = dialog.getByLabel("Åtkomstkod");
  await code.focus();
  expect(await clippedFocus(page), "the field's focus ring is whole").toBeNull();

  let accepted = false;
  await page.route("**/api/auth/login", (route) => {
    if (!accepted) return route.fulfill({ status: 401, json: { detail: "Felaktig åtkomstkod" } });
    signedIn = true;
    return route.fulfill({ json: { ok: true } });
  });
  await code.fill("fel-kod");
  await code.press("Enter");
  await expect(dialog.getByText("Felaktig åtkomstkod.")).toBeVisible();
  await expect(code, "a wrong code leaves the field to type it again").toBeFocused();
  await expect(setupHeading, "and the page as it was, covered").toBeHidden();

  accepted = true;
  await code.fill("test-access-code-1234");
  await dialog.getByRole("button", { name: "Logga in igen" }).click();
  await expect(dialog).toBeHidden();
  await expect(setupHeading).toBeVisible();
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

test("the leave question can be answered with a mouse while a dialog of the old design system is open under it", async ({ page }) => {
  // The page's own question to delete a recording is a modal of the old design system, which turns off pointer
  // events on the body. (It also hides what was in the document when it opened from assistive technology, the
  // question included; that is not asserted, and ends with the last modal of the old system.)
  await setup(page);
  await record(page, "Spela in");
  await page.getByRole("button", { name: "Stoppa" }).click();
  await page.getByRole("button", { name: "Ta bort" }).click();
  const deleting = page.getByRole("alertdialog", { name: "Ta bort inspelningen?" });
  await expect(deleting).toBeVisible();

  await page.goBack();
  const question = page.getByRole("alertdialog", { name: "Lämna sidan?" });
  await expect(question).toBeVisible();
  // By its words, not its role: the old system's modal has taken it out of the accessibility tree.
  await question.locator("button", { hasText: "Stanna kvar" }).click();
  await expect(question).toBeHidden();
  await expect(deleting, "the page's own question is as it was").toBeVisible();
});

test("the sign-in button answers a mouse while a dialog of the old design system is open on the page, and the edit in that dialog is kept", async ({ page, context }) => {
  await run(page, "run-review", "flow-2");
  await expect(page.getByRole("button", { name: /^Spela från/ }).first()).toBeVisible();
  await page.getByRole("button", { name: "Namnge talarna" }).click();
  const naming = page.getByRole("dialog", { name: "Namnge talarna" });
  const name = naming.getByLabel(/^Vem är Talare 1/);
  await name.fill("Zara Testsson");

  await endLogin(page);
  // A modal of the old design system turns off pointer events on the body, and takes the accessibility tree from
  // what is outside it: neither may reach the sign-in dialog.
  const tree = await page.locator("body").ariaSnapshot();
  expect(tree).toContain('heading "Du behöver logga in igen"');
  expect(tree).toContain('button "Logga in igen"');
  const popup = context.waitForEvent("page");
  await page.getByRole("alertdialog", signIn).getByRole("button", { name: "Logga in igen" }).click();
  await (await popup).close();

  await page.unroute("**/api/auth/status");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("alertdialog", signIn)).toBeHidden();
  // Pressing outside it closes a dialog of the old design system (its own rule): opened again, the edit is there.
  if (!(await naming.isVisible())) await page.getByRole("button", { name: "Namnge talarna" }).click();
  await expect(name).toHaveValue("Zara Testsson");
});

test("the cancel question open when the login ends is covered with the page, and is back after the new login", async ({ page }) => {
  await run(page, "run-running");
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
