/**
 * What a screen reader is told about the controls that need more than axe
 * checks: names and descriptions as Chromium's own tree gives them, the
 * groups around them, and the page titles.
 */
import { expect, test } from "@playwright/test";
import { axNode } from "./checks";
import { addParticipants, chooseMode, open, sending, setup, STATES } from "./screens";

test("the input modes are named by their title and described by their line", async ({ page }) => {
  await setup(page);
  for (const [id, name, description] of [
    ["satt-stromma", "Strömma", "Se texten medan du pratar."],
    ["satt-spela-in", "Spela in", "Spela in nu och transkribera efteråt."],
    ["satt-ladda-upp", "Ladda upp", "Välj en ljudfil från din enhet."],
  ]) {
    expect(await axNode(page.locator(`#${id}`))).toEqual({ role: "radio", name, description });
  }
  expect(await axNode(page.getByRole("radiogroup"))).toMatchObject({ name: "Hur vill du ge ljudet?" });
});

test("a field is not an unnamed group", async ({ page }) => {
  await setup(page);
  await chooseMode(page, "Spela in");
  await expect(page.locator('[data-slot="field"][role="group"]')).toHaveCount(0);
});

test("the added names are a named list the field points to", async ({ page }) => {
  await setup(page);
  await addParticipants(page, ["Anna Berg", "Erik Lund"]);
  await expect(page.getByRole("list", { name: "Tillagda namn" })).toBeVisible();
  const field = await axNode(page.getByRole("textbox", { name: /^Deltagare/ }));
  expect(field.description).toContain("2 namn tillagda");
});

test("the sending view is a page with a heading that takes focus, a named progress bar and a spoken stage", async ({ page }) => {
  await sending(page);
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Dokumentet skapas" })).toBeFocused();
  const bar = page.getByRole("progressbar", { name: "Uppladdning" });
  await expect(bar).toHaveAttribute("aria-valuenow", /^\d+$/);
  await expect(page.getByRole("status").filter({ hasText: "Laddar upp filen" })).toBeAttached();
  await expect(page).toHaveTitle("Dokumentet skapas · Tal till text");
});

test("the review's text fields are labelled", async ({ page }, info) => {
  await STATES.find((s) => s.name === "review-reject")!.go(page, info);
  expect(await axNode(page.locator("main textarea"))).toEqual({
    role: "textbox",
    name: "Avvisa körningen",
    description: "Ange en kort motivering. Körningen kommer att avbrytas.",
  });

  await STATES.find((s) => s.name === "review-text-edit")!.go(page, info);
  expect(await axNode(page.locator("main textarea"))).toMatchObject({ role: "textbox", name: "Innehåll för granskning" });
});

test("a page that is still loading says so, under the page's heading", async ({ page }) => {
  await page.route("**/api/auth/status", () => {});
  for (const path of ["/", "/flows"]) {
    await page.goto(path);
    await expect(page.getByRole("status", { name: "Laddar" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Tal till text" })).toBeAttached();
  }
});

test("while recording, the top bar names the mode and the folded details say what they are", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390-light", "the phone's top bar and folded details");
  await STATES.find((s) => s.name === "recording")!.go(page, info);
  await expect(page.getByRole("banner")).toContainText("Läge: Spela in");
  expect(await axNode(page.getByRole("button", { name: /Deltagare: Anna Berg/ }))).toMatchObject({
    name: "Uppgifter, Deltagare: Anna Berg",
  });
});

test("Eneo's own words on the failure view are marked as English", async ({ page }, info) => {
  await STATES.find((s) => s.name === "failure")!.go(page, info);
  await expect(page.getByText(/^Step 2 failed/)).toHaveAttribute("lang", "en");
});

test("the access code can be filled in by a password manager", async ({ page }, info) => {
  await STATES.find((s) => s.name === "signin-access-code")!.go(page, info);
  await expect(page.getByLabel("Åtkomstkod")).toHaveAttribute("autocomplete", "current-password");
});

for (const [state, title] of [
  ["signin-sso", "Logga in · Tal till text"],
  ["flow-list", "Välj ett flöde · Tal till text"],
  ["flow-gone", "Flödet är inte längre tillgängligt · Tal till text"],
  ["review", "Vem är vem? · Tal till text"],
  ["review-text-edit", "Sammanfattning · Tal till text"],
]) {
  test(`the ${state} page's title says what it is`, async ({ page }, info) => {
    await STATES.find((s) => s.name === state)!.go(page, info);
    await expect(page).toHaveTitle(title);
  });
}

test("the login's end is warned of five minutes ahead, and renewed in a new window without leaving the page", async ({ page, context }) => {
  let endsIn = 200;
  let refreshIn: number | undefined;
  let statusCalls = 0;
  await page.route("**/api/auth/status", (route) => {
    statusCalls++;
    return route.fulfill({
      json: {
        authenticated: true,
        auth_mode: "eneo_sso",
        user: { id: "user-1", email: "erik.lund@sundsvall.se", username: "Erik Lund" },
        session_ends_in: endsIn,
        ...(refreshIn === undefined ? {} : { refresh_in: refreshIn }),
      },
    });
  });
  // Eneo's handoff, as a signed-in browser gets it: straight back to the page the login asked for.
  const logins: URL[] = [];
  await context.route("**/api/auth/login?*", (route) => {
    const url = new URL(route.request().url());
    logins.push(url);
    return route.fulfill({ status: 303, headers: { location: url.searchParams.get("next") ?? "/flows" } });
  });
  await open(page, "/flows");
  const warning = page.getByRole("alertdialog", { name: "Du loggas snart ut" });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(/Inloggningen upphör kl\. \d\d:\d\d/);

  // The renewed login ends later and has a token to keep alive (the old one's keepalive had stopped).
  endsIn = 8 * 60 * 60;
  refreshIn = 1;
  const popup = context.waitForEvent("page");
  await warning.getByRole("button", { name: "Fortsätt arbeta" }).click();
  const window = await popup;
  await window.waitForEvent("close");
  await expect(warning).toBeHidden();
  await expect(page).toHaveURL(/\/flows$/);
  expect(logins[0]?.searchParams.get("renew"), "the login is a renewal, bound to this user").toBe("1");
  const renewed = statusCalls;
  await expect.poll(() => statusCalls - renewed, { timeout: 8_000 }).toBeGreaterThanOrEqual(2);
});

test("a review says when it must be done by, with the time, in the next year too", async ({ page }, info) => {
  for (const [state, now, deadline] of [
    ["review", "2026-09-24T12:00:00+02:00", "8 okt 11:01"],
    ["review-text-edit", "2026-12-28T12:00:00+01:00", "3 jan 2027 09:01"],
  ]) {
    await page.clock.setFixedTime(new Date(now));
    await STATES.find((s) => s.name === state)!.go(page, info);
    await expect(page.getByRole("main")).toContainText(`Granska senast ${deadline}. Därefter avbryts körningen.`);
  }
});

test("on a phone the docked primary action is part of the page's main content", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390-light", "the action docks on a phone");
  await setup(page);
  await expect(page.getByRole("main").getByRole("button", { name: "Starta strömning" })).toBeVisible();
});

test("a renewal that signed in someone else says so and keeps the page's login", async ({ page }) => {
  await open(page, "/inloggad?fel=annan-anvandare");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Du loggade in som en annan användare");
  await expect(page.getByRole("main")).toContainText("Stäng fönstret och logga in som Erik Lund för att fortsätta.");
});

test("a renewal after the login ended is refused: the window says so, stays, and tells no tab it signed in", async ({ page }) => {
  await page.addInitScript(() => {
    const said: unknown[] = [];
    (window as unknown as { said: unknown[] }).said = said;
    new BroadcastChannel("tal-till-text:session").addEventListener("message", (event) => said.push(event.data));
  });
  await open(page, "/inloggad?fel=utgangen");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Inloggningen har redan gått ut");
  await expect(page.getByRole("main")).toContainText("Stäng fönstret och logga in igen i Tal till text.");
  await expect(page).toHaveTitle("Inloggningen har gått ut · Tal till text");
  expect(await page.evaluate(() => (window as unknown as { said: unknown[] }).said)).toEqual([]);
});

test("with the access code, the warning renews the login by the code, on the page", async ({ page }) => {
  let endsIn = 200;
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { authenticated: true, auth_mode: "access_code", user: null, session_ends_in: endsIn } }),
  );
  const codes: string[] = [];
  await page.route("**/api/auth/login", (route) => {
    codes.push((route.request().postDataJSON() as { access_code: string }).access_code);
    endsIn = 90 * 60;
    return route.fulfill({ json: { ok: true } });
  });
  await open(page, "/flows");
  const warning = page.getByRole("alertdialog", { name: "Du loggas snart ut" });
  await expect(warning).toBeVisible();
  await warning.getByLabel("Åtkomstkod").fill("test-access-code-1234");
  await warning.getByRole("button", { name: "Fortsätt arbeta" }).click();
  await expect(warning).toBeHidden();
  expect(codes).toEqual(["test-access-code-1234"]);
  await expect(page).toHaveURL(/\/flows$/);
});
