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

test("a page that is still loading says so", async ({ page }) => {
  await page.route("**/api/auth/status", () => {});
  for (const path of ["/", "/flows"]) {
    await page.goto(path);
    await expect(page.getByRole("status", { name: "Laddar" })).toBeVisible();
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
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        auth_mode: "eneo_sso",
        user: { id: "user-1", email: "erik.lund@sundsvall.se", username: "Erik Lund" },
        session_ends_in: endsIn,
      },
    }),
  );
  // Eneo's handoff, as a signed-in browser gets it: straight back to the page the login asked for.
  await context.route("**/api/auth/login?*", (route) => {
    const next = new URL(route.request().url()).searchParams.get("next") ?? "/flows";
    return route.fulfill({ status: 303, headers: { location: next } });
  });
  await open(page, "/flows");
  const warning = page.getByRole("alertdialog", { name: "Du loggas snart ut" });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(/Inloggningen upphör kl\. \d\d:\d\d/);

  endsIn = 8 * 60 * 60;
  const popup = context.waitForEvent("page");
  await warning.getByRole("button", { name: "Fortsätt arbeta" }).click();
  const window = await popup;
  await window.waitForEvent("close");
  await expect(warning).toBeHidden();
  await expect(page).toHaveURL(/\/flows$/);
});

test("a review says when it must be done by", async ({ page }, info) => {
  for (const state of ["review", "review-text-edit"]) {
    await STATES.find((s) => s.name === state)!.go(page, info);
    await expect(page.getByRole("main")).toContainText(/Granska senast 8 okt \d\d:\d\d\. Därefter avbryts körningen\./);
  }
});

test("on a phone the docked primary action is part of the page's main content", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390-light", "the action docks on a phone");
  await setup(page);
  await expect(page.getByRole("main").getByRole("button", { name: "Starta strömning" })).toBeVisible();
});
