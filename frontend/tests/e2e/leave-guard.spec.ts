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
import { addParticipants, backLink, chooseFile, record, setup, setupFromList } from "./screens";

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

test("the bar's way back asks once each time; Stanna kvar stays, and the brand beside it is no second way off", async ({ page }) => {
  await recordingInVisit(page);
  const before = await historyOf(page);
  for (const _ of [1, 2]) {
    await backLink(page).click();
    await asked(page);
    await stay(page);
  }
  await expect(page.getByRole("link", { name: /^Tal till text/ })).toHaveCount(0);
  expect(await historyOf(page)).toEqual(before);
});

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
  await question(page).getByRole("button", { name: "Lämna sidan" }).click();
  await expect.poll(() => logouts.length).toBe(1);
  await expect(page).not.toHaveURL(new RegExp(`/flows/${ids.flows.flow1}`));
  await expect(question(page), "the way on is not asked a second time").toHaveCount(0);
  expect(logouts).toHaveLength(1);
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
