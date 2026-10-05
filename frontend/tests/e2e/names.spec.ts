/**
 * What a screen reader is told about the controls that need more than axe
 * checks: names and descriptions as Chromium's own tree gives them, the
 * groups around them, and the page titles.
 */
import { type Route } from "@playwright/test";
import { expect, test } from "./gate";
import { axNode } from "./checks";
import { addParticipants, backLink, chooseMode, isLaptop, result, run, sending, setup, STATES } from "./screens";
import ids from "../fixtures/ids.json";

test("the input modes are named by their title, described by their line, and say which is chosen", async ({ page }) => {
  await setup(page);
  await page.getByRole("radio", { name: /^Spela in/ }).click();
  for (const [name, description, checked] of [
    ["Strömma", "Se texten medan du pratar.", false],
    ["Spela in", "Spela in nu och transkribera efteråt.", true],
    ["Ladda upp", "Välj en ljudfil från din enhet.", false],
  ] as const) {
    expect(await axNode(page.getByRole("radio", { name: new RegExp(`^${name}`) }))).toEqual({ role: "radio", name, description, state: `checked=${checked}` });
  }
  expect(await axNode(page.getByRole("radiogroup"))).toMatchObject({ role: "radiogroup", name: "Hur vill du lägga till ljudet?" });
});

test("a field is not an unnamed group", async ({ page }) => {
  await setup(page);
  await chooseMode(page, "Spela in");
  // A group of the setup (the participants' field, say) is named by its label; none is left without a name.
  await expect(page.getByRole("main").locator('[role="group"]:not([aria-label]):not([aria-labelledby])')).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("group", { name: /^Deltagare/ })).toHaveCount(1);
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

test("a run opened while it runs keeps the flow's page: the way back, and the details it was started with", async ({ page }, info) => {
  await run(page, ids.runs.running);
  await expect(page.getByRole("heading", { level: 1, name: "Dokumentet skapas" })).toBeFocused();
  await expect(backLink(page)).toBeVisible();
  if (isLaptop(info)) {
    await expect(page.getByRole("main").getByText("Nämndmöte till rapport")).toBeVisible();
    await expect(page.getByRole("definition").filter({ hasText: "Anna Berg, Erik Lund" })).toBeVisible();
  } else {
    // Below a laptop's width the details fold into one line above the card.
    await expect(page.getByRole("button", { name: "Uppgifter, Deltagare: Anna Berg, Erik Lund" })).toBeVisible();
  }
  await expect(page.getByRole("main").getByRole("textbox")).toHaveCount(0);
});

test("a step that will stop for the person says what it asks while it is ahead, and not once it is done", async ({ page }) => {
  await run(page, ids.runs.beforeReview, ids.flows.flow2);
  // Flow 2 gives its result back in the run (delivery "payload"): it makes text, not a document.
  await expect(page.getByRole("heading", { level: 1, name: "Texten skapas" })).toBeVisible();
  const review = page.getByRole("listitem").filter({ hasText: "Talare" });
  await expect(review).toContainText("Väntar");
  await expect(review).toContainText("Här bekräftar du vem som är vem.");
  await expect(page.getByRole("listitem").filter({ hasText: "Transkribera" })).not.toContainText("Här ");
});

test("the dialog saves the names; the page's Godkänn och fortsätt then lets the run go on with them", async ({ page }, info) => {
  await STATES.find((s) => s.name === "naming-dialog")!.go(page, info);
  const saved: { edited_value: { speakers: { label: string; name: string | null }[] } }[] = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().includes("/review-checkpoints/")) saved.push(request.postDataJSON());
  });
  const dialog = page.getByRole("dialog", { name: "Namnge talarna" });
  await dialog.getByRole("combobox", { name: "Vem är Talare 2?" }).fill("Sara Holm");
  await dialog.getByRole("button", { name: "Spara namnen" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("listitem").filter({ hasText: "Talare 2" }), "the page shows the saved name").toContainText("Sara Holm");
  expect(saved, "the changed name was saved").toHaveLength(1);
  expect(saved[0].edited_value.speakers.find((s) => s.label === "SPEAKER_01")?.name).toBe("Sara Holm");
  await page.getByRole("button", { name: "Godkänn och fortsätt" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Texten skapas" })).toBeVisible();
  expect(saved, "approving saves nothing again").toHaveLength(1);
});

test("the name list opens with its chevron and closes with it again; a press outside closes it and leaves the dialog", async ({ page }, info) => {
  await STATES.find((s) => s.name === "naming-dialog")!.go(page, info);
  const dialog = page.getByRole("dialog", { name: "Namnge talarna" });
  const field = dialog.getByRole("combobox", { name: "Vem är Talare 3?" });
  const list = page.getByRole("listbox", { name: "Förslag: Vem är Talare 3?" });
  const row = dialog.getByRole("listitem").filter({ has: page.getByRole("combobox", { name: "Vem är Talare 3?" }) });
  await row.getByRole("button", { name: "Visa namn" }).click();
  await expect(list).toBeVisible();
  await expect(field, "the focus stays in the field").toBeFocused();
  await row.getByRole("button", { name: "Stäng listan" }).click();
  await expect(list).toBeHidden();
  await field.click();
  await expect(list).toBeVisible();
  await dialog.getByRole("heading", { name: "Namnge talarna" }).click();
  await expect(list, "a press outside the field and the list").toBeHidden();
  await expect(dialog).toBeVisible();
  // Choosing a row names the speaker and gives the focus back to the field.
  await field.click();
  await list.getByRole("option", { name: "Anna Berg" }).click();
  await expect(field).toHaveValue("Anna Berg");
  await expect(field).toBeFocused();
});

test("audio that cannot be played says so, and Försök igen tries it again", async ({ page, sentinel }) => {
  sentinel.expect({ console: /status of 404.*\/input-files\/.*\/audio/ });
  await page.route("**/input-files/*/audio", (route) => route.fulfill({ status: 404, body: "" }));
  await run(page, ids.runs.review, ids.flows.flow2);
  await expect(page.getByText("Ljudet kunde inte spelas.")).toBeVisible();
  await page.unroute("**/input-files/*/audio");
  await page.getByRole("button", { name: "Försök igen" }).click();
  await expect(page.getByText("Ljudet kunde inte spelas.")).toBeHidden();
});

test("a correction that cannot be saved says so, and offers another try and the unsaved corrections", async ({ page, sentinel }, info) => {
  sentinel.expect({ console: /net::ERR_FAILED.*\/transcript-corrections/ }, { requestFailed: /PATCH .*\/transcript-corrections.*: net::ERR_FAILED/ });
  await STATES.find((s) => s.name === "review")!.go(page, info);
  // Eneo cannot be reached for the corrections (the browser is offline): reading them was fine, writing them fails.
  await page.route("**/transcript-corrections**", (route) => (route.request().method() === "GET" ? route.fallback() : route.abort()));
  await page.getByRole("button", { name: "Anna Berg, ändra talare" }).first().click();
  const picker = page.getByRole("dialog", { name: "Ändra talare" });
  await picker.getByText("Erik Lund", { exact: true }).click();
  await picker.getByRole("button", { name: "Spara" }).click();
  await expect(page.getByRole("button", { name: "Försök spara igen" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hämta osparade rättningar" })).toBeVisible();
});

test("the player's row keeps the position slider a usable width on a phone, with Följ shown", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390-light", "a phone: names.spec.ts does not run on the 320 px project");
  await STATES.find((s) => s.name === "review")!.go(page, info);
  // Looking for a word stops the transcript following the playback: Följ is offered.
  await page.getByRole("textbox", { name: "Sök i transkriptet" }).fill("punkten");
  await expect(page.getByRole("button", { name: "Följ" })).toBeVisible();
  const slider = await page.getByRole("slider", { name: "Position i inspelningen" }).evaluate((thumb) => {
    const track = thumb.parentElement?.closest("[data-orientation]") ?? thumb;
    return track.getBoundingClientRect().width;
  });
  expect(slider, "the track of the position slider").toBeGreaterThanOrEqual(120);
  const player = await page.getByRole("region", { name: "Inspelning och transkript" }).boundingBox();
  const follow = await page.getByRole("button", { name: "Följ" }).boundingBox();
  expect(follow!.x + follow!.width, "Följ stays inside the card").toBeLessThanOrEqual(player!.x + player!.width);
});

test("an approved pause whose resume did not go through shows the saved names read-only; Fortsätt only resumes", async ({ page }) => {
  await run(page, ids.runs.reviewApproved, ids.flows.flow2);
  await expect(page.getByText("Namnen är redan sparade. Välj Fortsätt så går flödet vidare.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Avvisa" })).toHaveCount(0);
  // Approval has folded the transcript's corrections in; nothing corrected now would reach the document.
  await expect(page.getByRole("button", { name: /^Spela från/ }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^Rätta repliken/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /ändra talare$/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Namnge talarna" }).click();
  const dialog = page.getByRole("dialog", { name: "Namnge talarna" });
  await expect(dialog.getByRole("combobox", { name: "Vem är Talare 2?" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: /^Spara/ })).toHaveCount(0);
  // The page's Fortsätt goes on; the dialog's one action closes it (the footer's Stäng, after the header's own).
  await expect(dialog.getByRole("button", { name: /Fortsätt|Avbryt/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Stäng", exact: true }).last().click();
  await expect(dialog).toBeHidden();

  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.url().includes("/review-checkpoints/")) writes.push(request.url().split("/").filter(Boolean).at(-1)!);
  });
  await page.getByRole("button", { name: "Fortsätt", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Texten skapas" })).toBeVisible();
  expect(writes, "nothing saved or approved again").toEqual(["resume"]);
});

test("an approved text review shows the saved decision; a draft from before it is only a note, and Fortsätt only resumes", async ({ page }) => {
  const draft = "Kommunstyrelsen beslutade att sänka budgetramen.";
  const key = `tal-till-text:draft:user-1:review:${ids.runs.reviewTextApproved}:${ids.checkpoints.reviewText}`;
  await page.addInitScript(
    ({ text, key }) => {
      if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, JSON.stringify({ revision: 2, edit: { text } }));
    },
    { text: draft, key },
  );
  await run(page, ids.runs.reviewTextApproved);
  await expect(page.getByText("Granskningen är redan godkänd. Välj Fortsätt så går flödet vidare.")).toBeVisible();
  await expect(page.getByRole("article")).toHaveText("Kommunstyrelsen beslutade att höja budgetramen med två procent.");
  await expect(page.getByRole("button", { name: "Använd din version" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Redigera" })).toHaveCount(0);
  await expect(page.getByText(draft), "the draft stays to copy").toBeVisible();

  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.url().includes("/review-checkpoints/")) writes.push(request.url().split("/").filter(Boolean).at(-1)!);
  });
  await page.getByRole("button", { name: "Fortsätt", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Dokumentet skapas" })).toBeVisible();
  expect(writes).toEqual(["resume"]);
});

test("the decision is a pair at the end of its bar, Avvisa then Godkänn och fortsätt, of one height of at least 48 px", async ({ page }, info) => {
  for (const state of ["review", "review-text-edit"]) {
    await STATES.find((s) => s.name === state)!.go(page, info);
    const avvisa = page.getByRole("button", { name: "Avvisa" });
    const [reject, approve, bar] = await Promise.all([
      avvisa.boundingBox(),
      page.getByRole("button", { name: "Godkänn och fortsätt" }).boundingBox(),
      avvisa.locator("..").boundingBox(),
    ]);
    expect(reject!.height, `${state}: one height`).toBe(approve!.height);
    expect(approve!.height, `${state}: the height of the action a screen exists for`).toBeGreaterThanOrEqual(48);
    expect(approve!.x + approve!.width, `${state}: Godkänn och fortsätt ends the bar`).toBeCloseTo(bar!.x + bar!.width, 0);
    // Beside it, or above it where the bar wraps: never at the bar's other end.
    expect(approve!.x - (reject!.x + reject!.width), `${state}: Avvisa stands next to it`).toBeLessThanOrEqual(16);
  }
});

test("the review's text fields are labelled", async ({ page }, info) => {
  await STATES.find((s) => s.name === "review-reject")!.go(page, info);
  expect(await axNode(page.getByRole("main").locator("textarea"))).toEqual({
    role: "textbox",
    name: "Avvisa körningen",
    description: "Ange en kort motivering. Körningen kommer att avbrytas.",
  });

  await STATES.find((s) => s.name === "review-text-edit")!.go(page, info);
  expect(await axNode(page.getByRole("main").locator("textarea"))).toMatchObject({ role: "textbox", name: "Innehåll för granskning" });
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

test("the folded panels keep their content out of sight until their trigger is pressed", async ({ page }) => {
  await result(page);
  await expect(page.getByText("Flödets version 3")).toBeHidden();
  await page.getByRole("button", { name: /^Hur resultatet togs fram/ }).click();
  await expect(page.getByText("Flödets version 3")).toBeVisible();
  await run(page, ids.runs.failed);
  await expect(page.getByText(/^Step 2 failed/)).toBeHidden();
  await page.getByRole("button", { name: "Visa teknisk information" }).click();
  await expect(page.getByText(/^Step 2 failed/)).toBeVisible();
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

test("going from the list to a flow, the page is titled the flow", async ({ page }, info) => {
  await STATES.find((s) => s.name === "flow-list")!.go(page, info);
  await page.getByRole("link", { name: /Nämndmöte till rapport/ }).first().click();
  await expect(page).toHaveTitle(/Nämndmöte till rapport · Tal till text/);
});

test("going back from a flow to the list, the page is titled the list, not the flow", async ({ page }, info) => {
  await STATES.find((s) => s.name === "setup")!.go(page, info);
  await expect(page).not.toHaveTitle("Välj ett flöde · Tal till text");
  await backLink(page).click();
  await expect(page.getByRole("heading", { name: "Välj ett flöde" })).toBeVisible();
  await expect(page).toHaveTitle("Välj ett flöde · Tal till text");
});

test("the login's end is warned of five minutes ahead, and renewed in a new window without leaving the page", async ({ page, context }) => {
  let endsIn = 200;
  let refreshIn: number | undefined;
  let statusCalls = 0;
  await page.route("**/api/auth/status", (route) => {
    statusCalls++;
    return route.fulfill({
      json: {
        authenticated: true,
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
  await page.goto("/flows");
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

test("an old status answer that arrives after the renewal's moves neither the end nor the keepalive", async ({ page }) => {
  const signedIn = { authenticated: true, user: { id: "user-1", email: "erik.lund@sundsvall.se", username: "Erik Lund" } };
  const before = { ...signedIn, session_ends_in: 200 };
  const renewed = { ...signedIn, session_ends_in: 8 * 60 * 60, refresh_in: 1 };
  let answer: object = before;
  let calls = 0;
  let holdNext = false;
  const held: Route[] = [];
  await page.route("**/api/auth/status", (route) => {
    calls++;
    if (holdNext) {
      holdNext = false;
      held.push(route);
      return;
    }
    return route.fulfill({ json: answer });
  });
  await page.goto("/flows");
  const warning = page.getByRole("alertdialog", { name: "Du loggas snart ut" });
  await expect(warning).toBeVisible();

  // A slow check that will answer with the old login...
  holdNext = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => held.length).toBe(1);
  // ...then the renewal, answered at once...
  answer = renewed;
  await page.evaluate(() => new BroadcastChannel("tal-till-text:session").postMessage("inloggad"));
  await expect(warning).toBeHidden();
  // ...and the old answer last.
  await held[0].fulfill({ json: before });
  const renewedCalls = calls;
  await expect.poll(() => calls - renewedCalls, { timeout: 8_000 }).toBeGreaterThanOrEqual(2);
  await expect(warning).toBeHidden();
});

test("below a laptop's width the document's PDF opens in a new tab, and says so", async ({ page }, info) => {
  test.skip(isLaptop(info), "from a laptop's width the PDF opens in a dialog");
  await result(page);
  const link = page.getByRole("link", { name: "Öppna PDF i en ny flik" });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("href", /disposition=inline/);
});

test("a review says it waits for the person and, on a line of its own, when it must be done by, with the time, in the next year too", async ({ page }, info) => {
  for (const [state, now, deadline] of [
    ["review", "2026-09-24T12:00:00+02:00", "8 okt 11:01"],
    ["review-text-edit", "2026-12-28T12:00:00+01:00", "3 jan 2027 09:01"],
  ]) {
    await page.clock.setFixedTime(new Date(now));
    await STATES.find((s) => s.name === state)!.go(page, info);
    const main = page.getByRole("main");
    await expect.soft(main.getByText("Väntar på din granskning", { exact: true })).toBeVisible();
    await expect.soft(main.getByText(`Granska senast ${deadline}. Därefter avbryts körningen.`, { exact: true })).toBeVisible();
  }
});

test("on a phone the docked primary action is part of the page's main content", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390-light", "the action docks on a phone");
  await setup(page);
  await expect(page.getByRole("main").getByRole("button", { name: "Starta strömning" })).toBeVisible();
});

test("a renewal that signed in someone else says so and keeps the page's login", async ({ page }) => {
  await page.goto("/inloggad?fel=annan-anvandare");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Du loggade in som en annan användare");
  await expect(page.getByRole("main")).toContainText("Stäng fönstret och logga in som Erik Lund för att fortsätta.");
});

test("a renewal after the login ended is refused: the window says so, stays, and tells no tab it signed in", async ({ page }) => {
  await page.addInitScript(() => {
    const said: unknown[] = [];
    (window as unknown as { said: unknown[] }).said = said;
    new BroadcastChannel("tal-till-text:session").addEventListener("message", (event) => said.push(event.data));
  });
  await page.goto("/inloggad?fel=utgangen");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Inloggningen har redan gått ut");
  // The window cannot know whether the other tab's recording is on the device, so it promises nothing and says how to keep it.
  await expect(page.getByRole("main")).toContainText(
    "Stäng fönstret. Om du har en inspelning i den andra fliken: stoppa den och välj Spara som fil innan du loggar in igen.",
  );
  await expect(page.getByRole("main")).not.toContainText("finns kvar");
  await expect(page).toHaveTitle("Inloggningen har gått ut · Tal till text");
  expect(await page.evaluate(() => (window as unknown as { said: unknown[] }).said)).toEqual([]);
});

test("while a chosen file's length is read, the wait is said, not only written on the button", async ({ page }) => {
  // A file whose header the browser takes its time with: its length never arrives, so the check holds.
  await page.addInitScript(() => {
    Object.defineProperty(HTMLMediaElement.prototype, "src", { configurable: true, set() {}, get: () => "" });
  });
  await setup(page);
  await chooseMode(page, "Ladda upp");
  await page.locator('input[type="file"]').setInputFiles({ name: "stor-inspelning.wav", mimeType: "audio/wav", buffer: Buffer.alloc(64) });
  await expect(page.getByRole("button", { name: "Kontrollerar filen…" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Kontrollerar filen…" })).toBeAttached();
});

test("a file above what the module takes is refused before it is sent, in the words of a flow's own limit", async ({ page }) => {
  // The status says the module takes one MiB (and the envelope's room); the flow takes 200.
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({
      json: { authenticated: true, user: { id: "user-1", email: "erik.lund@sundsvall.se", username: "Erik Lund" }, session_ends_in: 3600, max_upload_bytes: 1024 * 1024 + 4096 },
    }),
  );
  const uploads: string[] = [];
  page.on("request", (request) => request.method() === "POST" && uploads.push(request.url()));
  await setup(page);
  await chooseMode(page, "Ladda upp");
  await page.locator('input[type="file"]').setInputFiles({ name: "stor-inspelning.wav", mimeType: "audio/wav", buffer: Buffer.alloc(2 * 1024 * 1024) });
  await expect(page.getByText(/Filen är större än flödet tar emot \(högst 1\s+MB\)\./)).toBeVisible();
  expect(uploads, "nothing was sent").toEqual([]);
});

test("a correction's save is said from its first word: the live region waits in the page before it", async ({ page }, info) => {
  test.skip(!isLaptop(info), "below a laptop's width the transcript waits in its tab");
  // The stub keeps no corrections: the save is answered here, as Eneo would, one revision on.
  await page.route("**/steps/*/transcript-corrections/", async (route) => {
    const body = route.request().postDataJSON();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return route.fulfill({
      json: {
        flow_run_id: ids.runs.done, step_id: route.request().url().split("/steps/")[1].split("/")[0], schema_version: body.schema_version,
        segments_hash: body.segments_hash, occurrences: body.occurrences ?? [], speaker_edits: body.speaker_edits ?? [],
        revision: (body.expected_revision ?? 0) + 1, stale: false, updated_at: "2026-09-25T20:00:00Z",
      },
    });
  });
  await result(page);
  // A live region added together with its text is often not read; one already there is.
  await page.evaluate(() => {
    (window as unknown as { regions: Set<Element> }).regions = new Set(document.querySelectorAll("[aria-live], [role=status], [role=alert]"));
  });
  await page.getByRole("button", { name: "Rätta repliken från 0:03" }).first().click();
  await page.keyboard.type(" i dag");
  await page.keyboard.press("Enter");
  const said = page.getByRole("status").filter({ hasText: "Sparar…" });
  await expect(said).toBeAttached();
  expect(await said.evaluate((element) => (window as unknown as { regions: Set<Element> }).regions.has(element))).toBe(true);
  await expect(page.getByRole("status").filter({ hasText: "Rättningar sparade" })).toBeAttached();
});

test("a passage's actions say which part they are in, as its play button does, so no two are named alike", async ({ page }, info) => {
  test.skip(!isLaptop(info), "below a laptop's width the transcript waits in its tab");
  await result(page);
  // Two parts, each starting at 0:00: the part tells the two passages apart.
  await expect(page.getByRole("button", { name: "Rätta repliken från 0:00 i del 1", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Rätta repliken från 0:00 i del 2", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Rätta repliken från 0:00", exact: true })).toHaveCount(0);
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  // The reduced-motion project ignores this spec, so the preference is set here.
  for (const [state, meter] of [
    ["recording", "the stage's waveform"],
    ["stromma", "the bar's level"],
  ] as const) {
    test(`${meter} does not glide between levels`, async ({ page }, info) => {
      test.skip(info.project.name !== "phone-390-light", "one width is enough: the rule is not width-bound");
      await STATES.find((s) => s.name === state)!.go(page, info);
      const bars = page.getByRole("region", { name: "Ljudet" }).locator("[data-lit]");
      expect(await bars.count()).toBeGreaterThan(0);
      const transitions = await bars.evaluateAll((all) => all.map((bar) => getComputedStyle(bar).transitionDuration));
      expect(new Set(transitions)).toEqual(new Set(["0s"]));
    });
  }
});

test("one long word in the live text wraps inside the sheet instead of widening it", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390-light", "a phone's width");
  await STATES.find((s) => s.name === "stromma")!.go(page, info);
  const log = page.getByRole("log", { name: "Preliminär text" });
  // Words as the live text brings them, in one of its paragraphs.
  await log.evaluate((element) => element.querySelector("p")!.append(" " + "Sammanträdesprotokollsjusteringsförfarandeanteckningar".repeat(6)));
  const { scrollWidth, clientWidth } = await log.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
});
