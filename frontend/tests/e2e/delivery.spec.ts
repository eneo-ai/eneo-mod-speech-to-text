/**
 * A finished run whose result goes to the flow's receiver: Eneo finishes the run before the receiver has confirmed it,
 * and the status's `result_delivery` follows the sending. The page shows the result at once, says where the sending
 * stands, and reads the status alone (never the audit-logged detail, the steps or the graph) until the sending ends. A
 * read that fails is tried again with the result kept; a run that is gone ends as before; leaving the run ends its reads.
 */
import { type Page, type Request } from "@playwright/test";
import { expect, test } from "./gate";
import { axe } from "./checks";
import ids from "../fixtures/ids.json";
import { endLogin, NO_CONFIRMED_WORDS, run, setup } from "./screens";

test.beforeEach(({}, info) => test.skip(info.project.name !== "laptop-1440-light", "behaviour, at one width"));

const RUN = ids.runs.done;
const FLOW = ids.flows.flow1;
const STATUS = `/api/eneo/flows/${FLOW}/runs/${RUN}/status/`;
const DETAIL = `/api/eneo/flows/${FLOW}/runs/${RUN}/`;
/** The reads a finished run is drawn from once: its detail (audit-logged), its steps and its run-pinned graph. */
const DRAWN_FROM = new Set([DETAIL, `${DETAIL}steps/`, `/api/eneo/flows/${FLOW}/graph/`]);

type Answer =
  | { status: string; delivery?: Record<string, unknown> | null }
  | { fail: number; headers?: Record<string, string> }
  | { raw: string };

/**
 * Eneo for the finished `done` run, its result sent to a receiver: the status answers what `answer` holds when it is
 * asked, and the detail is the stub's with an `outbound_http` result, or with `detail` over it. Every read the page makes
 * of the run is counted.
 */
async function sentRun(page: Page, first: Answer, detail: Record<string, unknown> = { result: { kind: "outbound_http", delivery_status: "pending" } }) {
  const state = { answer: first };
  const reads: string[] = [];
  page.on("request", (request: Request) => {
    const url = new URL(request.url());
    if (url.pathname.includes(`/runs/${RUN}/`) || url.searchParams.get("run_id") === RUN) reads.push(url.pathname);
  });
  await page.route((url) => url.pathname === STATUS, async (route) => {
    const answer = state.answer;
    if ("fail" in answer) return route.fulfill({ status: answer.fail, headers: answer.headers, json: { detail: "fel" } });
    if ("raw" in answer) return route.fulfill({ status: 200, contentType: "application/json", body: answer.raw });
    await route.fulfill({
      json: { id: RUN, flow_id: FLOW, status: answer.status, flow_version: 1, revision: 1, created_at: "2026-09-24T09:00:00Z", result_delivery: answer.delivery ?? null },
    });
  });
  await page.route((url) => url.pathname === DETAIL, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), ...detail, result_files: [] } });
  });
  const count = (path: string) => reads.filter((read) => read === path).length;
  return {
    set: (answer: Answer) => void (state.answer = answer),
    statusReads: () => count(STATUS),
    /** The reads of the detail, the steps and the graph; the recording's sound and words may come late and are not counted. */
    otherReads: () => reads.filter((read) => DRAWN_FROM.has(read)).length,
  };
}

const finished = (state: string, next_delivery_at: string | null = null): Answer => ({ status: "completed", delivery: { state, next_delivery_at } });
const h1 = (page: Page) => page.getByRole("heading", { level: 1 });
/** The note on the sending, as it stands. */
const note = (page: Page) => page.getByRole("note").filter({ hasText: /mottagaren/i });
/** What the page's own status region says, in the head with the heading: a change of the sending's state, once. */
const said = (page: Page) => h1(page).locator('xpath=ancestor::*[p[@role="status"]][1]/p[@role="status"]');
/** How the browser writes a moment's time of day, in its own time zone. */
const clock = (page: Page, iso: string) => page.evaluate((at) => new Date(at).toTimeString().slice(0, 5), iso);

test("a run that finishes while the page is open shows its result at once, then each state of the sending in turn, reading only the status", async ({ page, sentinel }) => {
  sentinel.expect(NO_CONFIRMED_WORDS);
  const eneo = await sentRun(page, { status: "running" });
  await run(page, RUN);
  await expect(page.getByRole("heading", { name: "Dokumentet skapas" })).toBeVisible();

  // Eneo's own order: the sending carries a time from the start, a retry its own, and the sending after it a time already
  // passed (in Eneo the retry's; here a second ago, which needs no wait of ten minutes); a sending says no time.
  eneo.set(finished("sending", new Date().toISOString()));
  await expect(h1(page)).toHaveText("Skickas");
  await expect(note(page)).toHaveText("Körningen är klar och resultatet är på väg till mottagaren.");
  await expect(said(page), "the state it opened with is read with the heading").toHaveText("");
  await expect(page.getByRole("heading", { name: "Transkribering" }), "the result is there while it is sent").toBeVisible();
  expect((await axe(page)).violations).toEqual([]);
  // The run's end read its detail and steps once; the sending's reads add none.
  await page.waitForTimeout(500);
  const others = eneo.otherReads();

  const at = new Date(Date.now() + 10 * 60_000).toISOString();
  eneo.set(finished("retry_scheduled", at));
  const time = await clock(page, at);
  await expect(h1(page)).toHaveText(`Nytt försök kl. ${time}`);
  await expect(note(page)).toHaveText(`Mottagaren har inte bekräftat att resultatet kom fram. Nytt försök kl. ${time}.`);
  await expect(said(page)).toHaveText(`Mottagaren har inte bekräftat att resultatet kom fram. Nytt försök kl. ${time}.`);
  expect((await axe(page)).violations).toEqual([]);

  const passed = new Date(Date.now() - 1_000).toISOString();
  eneo.set(finished("sending", passed));
  await expect(h1(page)).toHaveText("Skickas");
  await expect(said(page)).toHaveText("Körningen är klar och resultatet är på väg till mottagaren.");
  const sending = eneo.statusReads();
  await page.waitForTimeout(3_000);
  expect(eneo.statusReads() - sending, "a time passed is no reason to read without waiting").toBeLessThanOrEqual(2);

  eneo.set(finished("delivered"));
  await expect(h1(page)).toHaveText("Resultatet är skickat");
  await expect(note(page)).toHaveText("Resultatet skickades till mottagaren.");
  await expect(said(page)).toHaveText("Resultatet skickades till mottagaren.");
  expect((await axe(page)).violations).toEqual([]);
  const ended = eneo.statusReads();
  await page.waitForTimeout(5_000);
  expect(eneo.statusReads(), "no read once it is delivered").toBe(ended);
  expect(eneo.otherReads(), "only the status was read for the sending").toBe(others);
});

test("a reload while the result is on its way follows it again, to a sending Eneo gave up", async ({ page, sentinel }) => {
  sentinel.expect(NO_CONFIRMED_WORDS);
  const eneo = await sentRun(page, finished("sending"));
  await run(page, RUN);
  await expect(h1(page)).toHaveText("Skickas");
  await page.reload();
  await expect(h1(page)).toHaveText("Skickas");
  await expect(h1(page), "the heading has the focus, as on any result").toBeFocused();

  eneo.set(finished("dead_lettered"));
  await expect(h1(page)).toHaveText("Kunde inte skickas");
  await expect(note(page)).toHaveText("Eneo fick ingen bekräftelse från mottagaren. Inga fler försök är planerade.");
  expect((await axe(page)).violations).toEqual([]);
  const ended = eneo.statusReads();
  await page.waitForTimeout(5_000);
  expect(eneo.statusReads(), "given up is an end: no more reads").toBe(ended);
});

test("a status read that fails keeps the result and its state, says it could not be updated, and goes on when Eneo answers", async ({ page, sentinel }) => {
  sentinel.expect(NO_CONFIRMED_WORDS, { console: /status of 503.*\/status\//, optional: true });
  const eneo = await sentRun(page, finished("sending"));
  await run(page, RUN);
  await expect(h1(page)).toHaveText("Skickas");
  await expect(h1(page)).toBeFocused();

  eneo.set({ fail: 503 });
  // The line in sight, not the status region that says it.
  const stale = page.locator('p:not([role="status"])', { hasText: "Läget kunde inte uppdateras just nu. Sidan försöker igen av sig själv." });
  await expect(stale).toBeVisible();
  await expect(said(page), "said").toHaveText("Läget kunde inte uppdateras just nu. Sidan försöker igen av sig själv.");
  await expect(h1(page), "the last state stands, never 'kunde inte skickas'").toHaveText("Skickas");
  await expect(page.getByRole("heading", { name: "Transkribering" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" }), "never back to the start").toHaveCount(0);
  await expect(h1(page), "the focus stays").toBeFocused();

  eneo.set(finished("delivered"));
  await expect(h1(page)).toHaveText("Resultatet är skickat", { timeout: 15_000 });
  await expect(stale).toHaveCount(0);
  await expect(h1(page), "the focus stays through the recovery").toBeFocused();
  await expect(page.getByRole("heading", { name: "Transkribering" }), "and the result with it").toBeVisible();
});

test("a status read that fails for good keeps the result and a name not yet saved, says it could not be updated, and goes on when Eneo answers", async ({ page, sentinel }) => {
  sentinel.expect(NO_CONFIRMED_WORDS);
  const eneo = await sentRun(page, finished("sending"));
  await run(page, RUN);
  await expect(h1(page)).toHaveText("Skickas");
  await page.getByRole("button", { name: "Namnge talare" }).click();
  const name = page.getByRole("dialog", { name: "Namnge talarna" }).getByRole("combobox", { name: "Vem är Talare 1?" });
  await name.fill("Anna Berg");

  // 200 and JSON by its type, but no whole document: an answer that is not tried again by itself. Held until the page
  // has been seen through it, past a further read. The naming dialog is modal, so what lies behind it is found by CSS.
  eneo.set({ raw: "{" });
  const heading = page.locator("h1");
  const start = page.getByText("Hur vill du lägga till ljudet?");
  const stale = page.locator('p:not([role="status"])', { hasText: "Läget kunde inte uppdateras just nu. Sidan försöker igen av sig själv." });
  await expect(stale).toBeVisible();
  const failed = eneo.statusReads();
  await expect.poll(() => eneo.statusReads(), { message: "read again at the follow's pace" }).toBeGreaterThan(failed);
  await expect(heading, "the last state stands").toHaveText("Skickas");
  await expect(name, "the name not yet saved stays").toHaveValue("Anna Berg");
  await expect(start, "never back to the start").toHaveCount(0);

  eneo.set(finished("delivered"));
  await expect(heading).toHaveText("Resultatet är skickat", { timeout: 15_000 });
  await expect(stale).toHaveCount(0);
  await expect(name).toHaveValue("Anna Berg");
  await expect(start).toHaveCount(0);
});

test("a sending that ended between the status read and the detail read is shown ended, and is not followed", async ({ page, sentinel }) => {
  sentinel.expect(NO_CONFIRMED_WORDS);
  // The status is read first and still says a retry; the detail, read after it, already says delivered.
  const eneo = await sentRun(page, finished("retry_scheduled", new Date(Date.now() + 10 * 60_000).toISOString()), {
    result: { kind: "outbound_http", delivery_status: "delivered" },
  });
  await run(page, RUN);
  await expect(h1(page)).toHaveText("Resultatet är skickat");
  await expect(note(page)).toHaveText("Resultatet skickades till mottagaren.");
  const read = eneo.statusReads();
  // Past the sending's first pause of 2 s, and the next.
  await page.waitForTimeout(5_000);
  expect(eneo.statusReads(), "an ended sending is not followed").toBe(read);
  await expect(h1(page)).toHaveText("Resultatet är skickat");
});

test("a cancelled run whose sending Eneo has not yet given up reads no status after its detail, and stays the cancelled run", async ({ page, sentinel }) => {
  sentinel.expect(NO_CONFIRMED_WORDS);
  // Eneo leaves the sending's row of a run cancelled while its result went out; the run has no result of its own.
  const eneo = await sentRun(page, { status: "cancelled", delivery: { state: "sending", next_delivery_at: null } }, { status: "cancelled", result: null });
  await run(page, RUN);
  await expect(h1(page)).toHaveText("Körningen avbröts");
  const read = eneo.statusReads();
  // Past the sending's first pause of 2 s, and the next.
  await page.waitForTimeout(5_000);
  expect(eneo.statusReads(), "a run with no result sent is not followed").toBe(read);
  await expect(h1(page)).toHaveText("Körningen avbröts");
});

for (const gone of [404, 410]) {
  test(`a run Eneo answers ${gone} for while its result is on its way is gone, as before`, async ({ page, sentinel }) => {
    sentinel.expect(NO_CONFIRMED_WORDS, { console: new RegExp(`status of ${gone}.*\\/status\\/`), optional: true });
    const eneo = await sentRun(page, finished("sending"));
    await run(page, RUN);
    await expect(h1(page)).toHaveText("Skickas");
    eneo.set({ fail: gone });
    await expect(page.getByText("Körningen finns inte längre. Du kan starta en ny här.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" })).toBeVisible();
    expect(new URL(page.url()).searchParams.has("run"), "the address leaves the run").toBe(false);
  });
}

/** The `done` run opened from the setup's list, as an entry of its own. */
async function openFromList(page: Page) {
  await setup(page);
  await page.getByRole("region", { name: "Senaste körningar" }).getByRole("button", { name: /^Öppna, Styrelsemöte, möte 22 sep, / }).click();
  await expect(h1(page)).toHaveText("Skickas");
}

test("Back from a run whose result is on its way, and the choice of another run, read nothing more for it", async ({ page, sentinel }) => {
  // A read under way when the person leaves is called off; the sentinel counts no cancelled request as failed.
  sentinel.expect(NO_CONFIRMED_WORDS);
  const eneo = await sentRun(page, finished("sending"));
  await openFromList(page);
  // A read after the result shows is the sending's follow, not the run's own last read.
  const shown = eneo.statusReads();
  await expect.poll(eneo.statusReads, { message: "the sending is followed" }).toBeGreaterThan(shown);

  await page.goBack();
  await expect(page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" })).toBeVisible();
  const left = eneo.statusReads();
  await page.getByRole("region", { name: "Senaste körningar" }).getByRole("listitem").filter({ hasText: "Misslyckades" }).getByRole("button").click();
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("Skickas");
  await page.waitForTimeout(5_000);
  expect(eneo.statusReads(), "no read for the run left").toBe(left);
});

/** A navigation of the router to an address, as a link of its own would make it, without a load of the page. */
const clientNavigate = (page: Page, url: string) =>
  page.evaluate((to) => {
    history.pushState(null, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, url);

test("a change straight to another run while the sending is followed reads nothing more for the first", async ({ page, sentinel }) => {
  sentinel.expect(NO_CONFIRMED_WORDS);
  const eneo = await sentRun(page, finished("sending"));
  await run(page, RUN);
  await expect(h1(page)).toHaveText("Skickas");
  const shown = eneo.statusReads();
  await expect.poll(eneo.statusReads, { message: "the sending is followed" }).toBeGreaterThan(shown);

  await clientNavigate(page, `/flows/${FLOW}?run=${ids.runs.failed}`);
  await expect(h1(page)).not.toHaveText("Skickas");
  const left = eneo.statusReads();
  await page.waitForTimeout(5_000);
  expect(eneo.statusReads(), "no read for the run left").toBe(left);
});

test("Back while the login has ended: the read that waits for the new login is called off, and none goes after it", async ({ page, sentinel }) => {
  sentinel.expect(NO_CONFIRMED_WORDS);
  const eneo = await sentRun(page, finished("sending"));
  await openFromList(page);
  await endLogin(page);
  // The next read waits in the page for the new login; it is never sent while the login has ended.
  await page.waitForTimeout(3_000);
  const left = eneo.statusReads();
  await page.goBack();

  // The same person signs in again (the session answers again, and the page asks when it becomes visible).
  await page.unroute("**/api/auth/status");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("alertdialog", { name: "Du behöver logga in igen" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" })).toBeVisible();
  await page.waitForTimeout(5_000);
  expect(eneo.statusReads(), "no read for the run left, not even the one that waited").toBe(left);
});
