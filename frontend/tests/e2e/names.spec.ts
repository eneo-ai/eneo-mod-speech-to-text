/**
 * What a screen reader is told about the controls that need more than axe
 * checks: names and descriptions as Chromium's own tree gives them, the
 * groups around them, and the page titles.
 */
import { expect, test, type Route } from "@playwright/test";
import { axNode } from "./checks";
import { addParticipants, backLink, chooseMode, isLaptop, open, result, run, sending, setup, STATES } from "./screens";

test("the input modes are named by their title, described by their line, and say which is chosen", async ({ page }) => {
  await setup(page);
  await page.getByRole("radio", { name: /^Spela in/ }).click();
  for (const [id, name, description, checked] of [
    ["satt-stromma", "Strömma", "Se texten medan du pratar.", false],
    ["satt-spela-in", "Spela in", "Spela in nu och transkribera efteråt.", true],
    ["satt-ladda-upp", "Ladda upp", "Välj en ljudfil från din enhet.", false],
  ] as const) {
    expect(await axNode(page.locator(`#${id}`))).toEqual({ role: "radio", name, description, state: `checked=${checked}` });
  }
  expect(await axNode(page.getByRole("radiogroup"))).toMatchObject({ role: "radiogroup", name: "Hur vill du ge ljudet?" });
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

test("a run opened while it runs keeps the flow's page: the way back, and the details it was started with", async ({ page }, info) => {
  await run(page, "run-running");
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
  await run(page, "run-before-review", "flow-2");
  // flow-2 gives its result back in the run (delivery "payload"): it makes text, not a document.
  await expect(page.getByRole("heading", { level: 1, name: "Texten skapas" })).toBeVisible();
  const review = page.getByRole("listitem").filter({ hasText: "Talare" });
  await expect(review).toContainText("Väntar");
  await expect(review).toContainText("Här bekräftar du vem som är vem.");
  await expect(page.getByRole("listitem").filter({ hasText: "Transkribera" })).not.toContainText("Här ");
});

test("naming the speakers and going on is one action: a changed name is saved, then the run goes on", async ({ page }, info) => {
  await STATES.find((s) => s.name === "naming-dialog")!.go(page, info);
  const saved: { edited_value: { speakers: { label: string; name: string | null }[] } }[] = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().includes("/review-checkpoints/")) saved.push(request.postDataJSON());
  });
  const dialog = page.getByRole("dialog", { name: "Namnge talarna" });
  await dialog.getByRole("combobox", { name: "Vem är Talare 2?" }).fill("Sara Holm");
  await dialog.getByRole("button", { name: "Spara och fortsätt" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Texten skapas" })).toBeVisible();
  expect(saved, "the changed name was saved before the run went on").toHaveLength(1);
  expect(saved[0].edited_value.speakers.find((s) => s.label === "SPEAKER_01")?.name).toBe("Sara Holm");
});

test("an approved pause whose resume did not go through shows the saved names read-only; Fortsätt only resumes", async ({ page }) => {
  await run(page, "run-review-approved", "flow-2");
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
  await dialog.getByRole("button", { name: "Avbryt" }).click();

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
  await page.addInitScript((text) => {
    const key = "tal-till-text:draft:user-1:review:run-review-text-approved:cp-2";
    if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, JSON.stringify({ revision: 2, edit: { text } }));
  }, draft);
  await run(page, "run-review-text-approved");
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

test("an old status answer that arrives after the renewal's moves neither the end nor the keepalive", async ({ page }) => {
  const signedIn = { authenticated: true, auth_mode: "eneo_sso", user: { id: "user-1", email: "erik.lund@sundsvall.se", username: "Erik Lund" } };
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
  await open(page, "/flows");
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
  // The window cannot know whether the other tab's recording is on the device, so it promises nothing and says how to keep it.
  await expect(page.getByRole("main")).toContainText(
    "Stäng fönstret. Om du har en inspelning i den andra fliken: stoppa den och välj Spara som fil innan du loggar in igen.",
  );
  await expect(page.getByRole("main")).not.toContainText("finns kvar");
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

test("a correction's save is said from its first word: the live region waits in the page before it", async ({ page }, info) => {
  test.skip(!isLaptop(info), "below a laptop's width the transcript waits in its tab");
  // The stub keeps no corrections: the save is answered here, as Eneo would, one revision on.
  await page.route("**/steps/*/transcript-corrections/", async (route) => {
    const body = route.request().postDataJSON();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return route.fulfill({
      json: {
        flow_run_id: "run-done", step_id: route.request().url().split("/steps/")[1].split("/")[0], schema_version: body.schema_version,
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
