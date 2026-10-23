/**
 * Leaving a page that holds work: a recording must not be lost to a stray navigation. The router's blocker asks, in the
 * page's own dialog, for every departure the router sees (Back, Forward, a link in the bar, the brand); Logga ut asks
 * before the session is ended; reload and Back from the first page of a visit are the browser's own question
 * (`beforeunload`), since no in-app navigation exists there to block. The page keeps no history entry of its own.
 *
 * One width is enough: this is about history and requests, and the dev server's StrictMode runs every effect twice.
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./gate";
import ids from "../fixtures/ids.json";
import { addParticipants, backLink, chooseFile, isLaptop, record, resultTab, setup, setupFromList, startOver, stop, unsavedCorrections } from "./screens";

test.beforeEach(({}, info) => test.skip(info.project.name !== "laptop-1440-light", "history and requests, at one width"));

const question = (page: Page) => page.getByRole("alertdialog", { name: "Lämna sidan?" });
const recordingRuns = (page: Page) => expect(page.getByRole("button", { name: "Stoppa" })).toBeVisible();
const address = (page: Page) => page.evaluate(() => location.pathname + location.search);
const historyOf = (page: Page) => page.evaluate(() => ({ length: history.length, state: JSON.stringify(history.state), at: location.pathname + location.search }));

/** A visit with a page behind it: the flow list, then the flow's page by its link, and a recording started on it. */
async function recordingInVisit(page: Page) {
  await setupFromList(page);
  await record(page, "Spela in");
}

/** What is still there when the question has been asked: the recording that runs, or the names typed that the browser would not keep. */
type Held = (page: Page) => Promise<unknown>;
const namesTyped: Held = (page) => expect(page.getByRole("button", { name: "Ta bort Anna Berg" })).toBeVisible();

/** The question is open with its answer that stays focused, and nothing has been lost. */
async function asked(page: Page, held: Held = recordingRuns) {
  await expect(question(page)).toBeVisible();
  await expect(question(page).getByRole("button", { name: "Stanna kvar" }), "staying has the focus").toBeFocused();
  await held(page);
}

async function stay(page: Page, held: Held = recordingRuns) {
  await question(page).getByRole("button", { name: "Stanna kvar" }).click();
  await expect(question(page)).toHaveCount(0);
  await held(page);
}

/** The addresses the page reads its own status from, counted as a request is made. */
function countStatusReads(page: Page) {
  const reads: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "GET" && new URL(request.url()).pathname.replace(/\/$/, "") === "/api/auth/status") reads.push(request.url());
  });
  return reads;
}

test("Back in the middle of a visit asks once; Stanna kvar leaves the page, the address and the history as they were; Lämna sidan goes to the list", async ({ page }) => {
  await recordingInVisit(page);
  const before = await historyOf(page);
  await page.goBack();
  await asked(page);
  await stay(page);
  expect(await historyOf(page), "nothing moved, nothing was added").toEqual(before);

  await page.goBack();
  await asked(page);
  await question(page).getByRole("button", { name: "Lämna sidan" }).click();
  await expect(page.getByRole("heading", { name: "Välj ett flöde" })).toBeVisible();
  expect(await address(page)).toBe("/flows");
});

test("repeated Back while the question is open leaves one dialog, and nothing stacked", async ({ page }) => {
  await recordingInVisit(page);
  const before = await historyOf(page);
  await page.goBack();
  await asked(page);
  for (let press = 0; press < 3; press += 1) await page.evaluate(() => history.back());
  await page.waitForTimeout(500);
  await asked(page);
  await expect(question(page)).toHaveCount(1);
  await expect(page.locator("dialog[open]"), "one dialog open in all").toHaveCount(1);
  await stay(page);
  expect(await historyOf(page)).toEqual(before);
});

test("Back from the first page of a visit is the browser's own question, once there is something to lose; dismissing it keeps the page and the recording, accepting leaves", async ({ page }) => {
  await setup(page);
  const lengthBefore = await page.evaluate(() => history.length);
  await record(page, "Spela in");
  expect(await page.evaluate(() => history.length), "starting a recording adds no history entry").toBe(lengthBefore);

  const dialogs: string[] = [];
  let accept = false;
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void (accept ? dialog.accept() : dialog.dismiss());
  });
  const flow = await address(page);
  await page.goBack({ timeout: 3_000 }).catch(() => null);
  await page.waitForTimeout(500);
  expect(dialogs, "the browser asked, the page's dialog did not").toEqual(["beforeunload"]);
  await expect(question(page)).toHaveCount(0);
  expect(await address(page)).toBe(flow);
  await recordingRuns(page);

  accept = true;
  await page.goBack({ timeout: 3_000 }).catch(() => null);
  await expect.poll(() => page.url()).toBe("about:blank");
  expect(dialogs).toEqual(["beforeunload", "beforeunload"]);
});

test("the page writing ?run= (a run starts) asks nothing and adds no history entry; Back from the run then goes to the list once", async ({ page }) => {
  await page.goto("/flows");
  await page.getByRole("link", { name: /^Nämndmöte till rapport/ }).click();
  await chooseFile(page);
  const before = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: "Skapa dokument" }).click();
  await expect(page).toHaveURL(/\?run=/);
  await expect(page.getByRole("heading", { name: "Dokumentet skapas" })).toBeVisible();
  await expect(question(page)).toHaveCount(0);
  expect(await page.evaluate(() => history.length), "the address was replaced, not pushed").toBe(before);

  await page.goBack();
  await expect(page.getByRole("heading", { name: "Välj ett flöde" })).toBeVisible();
  expect(await address(page)).toBe("/flows");
  await expect(question(page)).toHaveCount(0);
});

test("Back from an earlier review opened from the setup, with an edit the browser would not keep, asks first; Stanna kvar keeps the edit", async ({ page }) => {
  // The tab keeps nothing: the edit is the page's alone.
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (this === window.sessionStorage) throw new DOMException("full", "QuotaExceededError");
      return set.call(this, key, value);
    };
  });
  // Among the flow's earlier runs, a review waits for this person.
  await page.route(
    (url) => url.pathname === `/api/eneo/flows/${ids.flows.flow1}/runs/`,
    (route) => route.fulfill({ json: { items: [{ id: ids.runs.reviewText, flow_id: ids.flows.flow1, status: "awaiting_review", created_at: "2026-09-24T09:00:00Z" }], has_more: false, count: 1 } }),
  );
  await setup(page);
  await page.getByRole("button", { name: /^Granska, körningen / }).first().click();
  await page.getByRole("button", { name: "Redigera", exact: true }).click();
  const field = page.getByRole("textbox", { name: "Innehåll för granskning" });
  await field.fill("Beslutet som bara sidan har.");
  const edited: Held = () => expect(field).toHaveValue("Beslutet som bara sidan har.");
  const review = await address(page);
  await page.goBack();
  await asked(page, edited);
  await stay(page, edited);
  expect(await address(page), "the review's entry stays").toBe(review);
});

test("the bar's way back and the brand beside it ask each time; Stanna kvar stays", async ({ page }, info) => {
  await recordingInVisit(page);
  const before = await historyOf(page);
  const brand = page.getByRole("link", { name: /^Tal till text/ });
  // The brand is in the bar from a laptop's width; below it the way back is the bar's only way off.
  for (const way of [backLink(page), backLink(page), ...(isLaptop(info) ? [brand] : [])]) {
    await way.click();
    await asked(page);
    await stay(page);
  }
  if (!isLaptop(info)) await expect(brand).toHaveCount(0);
  expect(await historyOf(page)).toEqual(before);
});

test("unsaved transcript corrections ask before leaving; a successful retry removes the question", async ({ page, sentinel }) => {
  sentinel.expect({ console: /net::ERR_FAILED.*\/transcript-corrections/ }, { requestFailed: /PATCH .*\/transcript-corrections.*: net::ERR_FAILED/ });
  await unsavedCorrections(page);
  const held: Held = (p) => expect(p.getByRole("button", { name: "Hämta osparade rättningar" })).toBeVisible();
  await held(page);
  await expect(page.getByRole("button", { name: "Godkänn och fortsätt" }), "failed corrections cannot be approved").toBeDisabled();
  await backLink(page).click();
  await asked(page, held);
  await expect(question(page)).toContainText("rättningar");
  await stay(page, held);

  await page.getByRole("button", { name: /^Öppna konto för/ }).click();
  await page.getByRole("menuitem", { name: "Logga ut" }).click();
  await asked(page, held);
  await stay(page, held);
  await page.keyboard.press("Escape");

  await page.unroute("**/transcript-corrections**");
  await page.route("**/steps/*/transcript-corrections/", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const body = route.request().postDataJSON();
    await route.fulfill({ json: {
      ...body,
      flow_run_id: ids.runs.review,
      step_id: ids.steps.audio,
      revision: (body.expected_revision ?? 0) + 1,
      stale: false,
      updated_at: "2026-09-25T20:00:00Z",
    } });
  });
  await page.getByRole("button", { name: "Försök spara igen" }).click();
  await expect(page.getByRole("button", { name: "Hämta osparade rättningar" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Godkänn och fortsätt" })).toBeEnabled();
  await backLink(page).click();
  await expect(page.getByRole("heading", { name: "Välj ett flöde" })).toBeVisible();
  await expect(question(page)).toHaveCount(0);
});

test("Logga ut while recording, answered Stanna kvar: the focus goes back to the account's button, as the menu is gone", async ({ page }) => {
  await setup(page);
  await record(page, "Spela in");
  const account = page.getByRole("button", { name: /^Öppna konto för/ });
  await account.click();
  await page.getByRole("menuitem", { name: "Logga ut" }).click();
  await asked(page);
  await stay(page);
  await expect(account, "where the person was, not the page's body").toBeFocused();
});

test("unsaved result corrections are kept in the tab: after a reload the page shows them and saves them", async ({ page, sentinel }) => {
  sentinel.expect({ console: /net::ERR_FAILED.*\/transcript-corrections/ }, { requestFailed: /PATCH .*\/transcript-corrections.*: net::ERR_FAILED/ });
  await unsavedCorrections(page, "result");
  // The network is back; the tab is reloaded (as a phone does with a tab it put away), the browser's question accepted.
  await page.unroute("**/transcript-corrections**");
  const saved: unknown[] = [];
  await page.route("**/steps/*/transcript-corrections/", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const body = route.request().postDataJSON();
    saved.push(body);
    await route.fulfill({ json: { ...body, flow_run_id: ids.runs.done, step_id: ids.steps.audio, revision: (body.expected_revision ?? 0) + 1, stale: false, updated_at: "2026-09-25T20:00:00Z" } });
  });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.reload();
  await expect(page.getByRole("heading", { name: "Dokumentet är klart" })).toBeVisible();
  await resultTab(page, "Transkribering");
  await expect.poll(() => saved.length, { message: "the kept correction is saved again" }).toBe(1);
  await expect(page.getByRole("button", { name: "Talare 2, ändra talare" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Hämta osparade rättningar" })).toHaveCount(0);
});

for (const action of ["Alla flöden", "Ny inspelning"]) {
  test(`unsaved result corrections survive cancelling ${action}`, async ({ page, sentinel }) => {
    sentinel.expect({ console: /net::ERR_FAILED.*\/transcript-corrections/ }, { requestFailed: /PATCH .*\/transcript-corrections.*: net::ERR_FAILED/ });
    await unsavedCorrections(page, "result");
    const held: Held = (p) => expect(p.getByRole("button", { name: "Hämta osparade rättningar" })).toBeVisible();
    if (action === "Alla flöden") await backLink(page).click();
    else await startOver(page);
    await asked(page, held);
    await stay(page, held);
    await resultTab(page, "Transkribering");
    await expect(page.getByRole("button", { name: "Talare 2, ändra talare" }).first()).toBeVisible();
    if (action === "Alla flöden") await backLink(page).click();
    else await startOver(page);
    await asked(page, held);
    await question(page).getByRole("button", { name: "Lämna sidan" }).click();
    await expect(page.getByRole("heading", { name: action === "Alla flöden" ? "Välj ett flöde" : "Hur vill du lägga till ljudet?" })).toBeVisible();
    await expect(question(page)).toHaveCount(0);
  });
}

test("Logga ut asks before the logout request is sent: Stanna kvar sends none, Lämna sidan sends it once and the way on to the start is not asked again", async ({ page }) => {
  const logouts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.replace(/\/$/, "") === "/api/auth/logout") logouts.push(request.url());
  });
  // The account menu is in the bar only where nothing is being recorded (signing out would drop it). What leaving would
  // lose there is typed work the browser refused to keep.
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (this === window.sessionStorage) throw new DOMException("full", "QuotaExceededError");
      return set.call(this, key, value);
    };
  });
  await page.goto("/flows");
  await page.getByRole("link", { name: /^Nämndmöte till rapport/ }).click();
  await expect(page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" })).toBeVisible();
  await addParticipants(page, ["Anna Berg"]);
  const signOut = async () => {
    // The menu stays open behind the question, for it to give the focus back to.
    const item = page.getByRole("menuitem", { name: "Logga ut" });
    if (!(await item.isVisible())) await page.getByRole("button", { name: /^Öppna konto för/ }).click();
    await item.click();
  };
  await signOut();
  await asked(page, namesTyped);
  expect(logouts, "asked first").toEqual([]);
  await stay(page, namesTyped);
  expect(logouts, "Stanna kvar sends none").toEqual([]);

  await signOut();
  await asked(page, namesTyped);
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: { authenticated: false, user: null } }));
  await question(page).getByRole("button", { name: "Lämna sidan" }).click();
  await expect.poll(() => logouts.length).toBe(1);
  await expect(page).not.toHaveURL(new RegExp(`/flows/${ids.flows.flow1}`));
  await expect(question(page), "the way on is not asked a second time").toHaveCount(0);
  expect(logouts).toHaveLength(1);
  await expect(page.getByRole("heading", { name: "Du är utloggad" })).toBeFocused();
  await expect(page.getByText(/Inspelningar som inte har skickats ligger kvar/)).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Logga in med Eneo" })).toBeFocused();
});

test("Logga ut while recording asks first, and Stanna kvar keeps the recording and the login", async ({ page }) => {
  const logouts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.replace(/\/$/, "") === "/api/auth/logout") logouts.push(request.url());
  });
  await recordingInVisit(page);
  await page.getByRole("button", { name: /^Öppna konto för/ }).click();
  await page.getByRole("menuitem", { name: "Logga ut" }).click();
  await asked(page);
  await stay(page);
  expect(logouts, "nothing signed out").toEqual([]);
});

test("Stanna kvar after Logga ut gives the focus back to the account's button, whose menu asked", async ({ page }) => {
  await recordingInVisit(page);
  const account = page.getByRole("button", { name: /^Öppna konto för/ });
  await account.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Logga ut" }).focus();
  await page.keyboard.press("Enter");
  await asked(page);
  await stay(page);
  await expect(account, "not the page's body: the menu that asked is gone").toBeFocused();
});

test("Forward after Stanna kvar asks nothing and breaks nothing", async ({ page }) => {
  await recordingInVisit(page);
  await page.goBack();
  await asked(page);
  await stay(page);
  const before = await historyOf(page);
  await page.goForward().catch(() => null);
  await page.waitForTimeout(300);
  await expect(question(page)).toHaveCount(0);
  await recordingRuns(page);
  expect(await historyOf(page)).toEqual(before);
});

test("a reload asks only through the browser's beforeunload", async ({ page }) => {
  await recordingInVisit(page);
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  await page.reload({ timeout: 3_000 }).catch(() => null);
  await page.waitForTimeout(500);
  expect(dialogs).toEqual(["beforeunload"]);
  await expect(question(page)).toHaveCount(0);
  await recordingRuns(page);
});

test("a stopped recording the device keeps is left without the browser's question, which would say what the page's does not; one the device cannot keep still asks", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  await recordingInVisit(page);
  await stop(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "En inspelning har inte skickats" })).toBeVisible();
  expect(dialogs, "kept on the device, it waits among the unsent recordings").toEqual([]);

  // A browser with no storage for recordings keeps it in this tab alone: a reload would lose it.
  await page.addInitScript(() => Object.defineProperty(window, "indexedDB", { value: undefined }));
  await page.reload();
  await setup(page);
  await record(page, "Spela in");
  await stop(page);
  await page.reload({ timeout: 3_000 }).catch(() => null);
  await page.waitForTimeout(500);
  expect(dialogs).toEqual(["beforeunload"]);
  await expect(page.getByRole("heading", { name: "Inspelningen är klar" })).toBeVisible();
});

test("the gate is not run again by any of this: the status is read once for each page, and its own way to the start when the first read says nobody is signed in is not asked", async ({ page }) => {
  const reads = countStatusReads(page);
  await page.goto("/flows");
  await expect(page.getByRole("heading", { name: "Välj ett flöde" })).toBeVisible();
  // What one page reads (the dev server runs its effects twice).
  const perPage = reads.length;
  expect(perPage).toBeGreaterThan(0);
  await page.getByRole("link", { name: /^Nämndmöte till rapport/ }).click();
  await expect(page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" })).toBeVisible();
  await record(page, "Spela in");
  const afterTwoPages = reads.length;
  expect(afterTwoPages, "the list's and the flow's, as much each").toBe(2 * perPage);
  await page.goBack();
  await asked(page);
  await stay(page);
  await backLink(page).click();
  await asked(page);
  await stay(page);
  await page.waitForTimeout(500);
  expect(reads.length, "asking and staying read nothing").toBe(afterTwoPages);

  // Nobody signed in: the page's own way to the start is a navigation, but the question is not yet active.
  const second = await page.context().newPage();
  await second.route("**/api/auth/status", (route) => route.fulfill({ json: { authenticated: false, user: null } }));
  await second.goto(`/flows/${ids.flows.flow1}`);
  await expect(second).toHaveURL(/\/$/);
  await expect(question(second)).toHaveCount(0);
});

test("/inloggad?fel=utgangen opened while signed out shows its page, with its title, and neither redirects nor asks", async ({ page }) => {
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: { authenticated: false, user: null } }));
  await page.goto("/inloggad?fel=utgangen");
  await expect(page).toHaveTitle("Inloggningen har gått ut · Tal till text");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForTimeout(500);
  expect(await address(page)).toBe("/inloggad?fel=utgangen");
  await expect(question(page)).toHaveCount(0);
});
