/**
 * What a person is given when the page changes: the title at once, and, when the new page has its content, one
 * announcement, the focus in the page's heading and the scroll (to the top for a link, back where it was for Back). A
 * page behind AuthGate is a spinner until the session answers, so RouteEffects waits for the page to say it has its
 * content. A change of the address's query alone is the page's own state: nothing happens. Back from a run to the setup
 * leaves the run's actions behind: what Eneo answers to them later does not take the setup's place.
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./gate";
import { axe, blocking } from "./checks";
import ids from "../fixtures/ids.json";
import { backLink, flows, NO_CONFIRMED_WORDS, record, setup, startOver } from "./screens";

test.beforeEach(({}, info) => test.skip(!["laptop-1440-light", "phone-390-light"].includes(info.project.name), "two widths are enough"));

const LIST_TITLE = "Välj ett flöde · Tal till text";
const LOGIN_TITLE = "Logga in · Tal till text";

declare global {
  interface Window {
    routeSaid: string[];
    scrolls: unknown[][];
  }
}

/** Records what each announcement puts in the polite live region, and every call that scrolls the window. */
function listen() {
  const said: string[] = [];
  let shown = "";
  new MutationObserver(() => {
    const text = document.querySelector('[data-astryx-live-region="polite"]')?.textContent?.trim() ?? "";
    if (text && !shown) said.push(text);
    shown = text;
  }).observe(document, { subtree: true, childList: true, characterData: true });
  window.routeSaid = said;
  window.scrolls = [];
  const scrollTo = window.scrollTo.bind(window) as (...args: unknown[]) => void;
  window.scrollTo = ((...args: unknown[]) => {
    window.scrolls.push(args);
    scrollTo(...args);
  }) as typeof window.scrollTo;
}

const said = (page: Page) => page.evaluate(() => window.routeSaid);
const scrolls = (page: Page) => page.evaluate(() => window.scrolls);
const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY));

/** Where the focus is: its element, its words and whether it stands in a heading in the page's main region. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement;
    return {
      tag: element?.tagName.toLowerCase() ?? null,
      text: element?.textContent?.trim().slice(0, 80) ?? "",
      inMain: !!element?.closest('main, [role="main"]'),
      heading: !!element?.closest("h1, h2, h3, h4, h5, h6, [data-phase-heading]"),
    };
  });

/** The session's answer arrives `ms` late: the page behind AuthGate is a spinner meanwhile. */
async function delaySession(page: Page, ms: number) {
  await page.route("**/api/auth/status", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue().catch(() => undefined);
  });
}

/** A navigation of the router, as a Back or Forward would make it, to an address no link of the app leads to. */
const clientNavigate = (page: Page, url: string) =>
  page.evaluate((to) => {
    history.pushState(null, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, url);

test("a link to a flow and Back, with the session's answer late: the title at once, the rest when the page has its content", async ({ page }, info) => {
  await page.addInitScript(listen);
  // A window short enough that the list scrolls.
  await page.setViewportSize({ width: info.project.use.viewport!.width, height: 380 });
  await flows(page);
  await page.waitForTimeout(500);
  // The first load says nothing and moves nothing.
  expect(await said(page), "the first load announces nothing").toEqual([]);
  expect((await focused(page)).tag, "the first load moves no focus").toBe("body");
  expect(await scrolls(page), "the first load scrolls nothing").toEqual([]);

  const offset = await page.evaluate(() => {
    window.scrollTo(0, 400);
    return Math.round(window.scrollY);
  });
  expect(offset, "the list scrolls in this window").toBeGreaterThan(100);
  await page.evaluate(() => (window.scrolls = []));

  // Long enough that the spinner is still up after the checks below on a slow machine.
  await delaySession(page, 3_000);
  // A link, followed as a click does, without the test scrolling the window to it first.
  await page.getByRole("link", { name: /Nämndmöte till rapport/ }).evaluate((link) => (link as HTMLElement).click());
  // The title is the route's at once; nothing else yet: the session has not answered, the page is a spinner.
  await expect.poll(() => page.title(), { timeout: 1_000 }).toBe("Tal till text");
  await expect(page.getByRole("status", { name: "Laddar" })).toBeVisible();
  await page.waitForTimeout(700);
  expect(await said(page), "nothing is said over a spinner").toEqual([]);
  const meanwhile = await focused(page);
  await expect(page.getByRole("status", { name: "Laddar" }), "the focus was read over the spinner").toBeVisible();
  expect(meanwhile.heading, `no focus in the spinner's heading (${JSON.stringify(meanwhile)})`).toBe(false);

  await expect(page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" })).toBeVisible();
  const flowTitle = await page.title();
  await expect.poll(() => said(page), { timeout: 1_000, message: "the page's title is said once it has its content" }).toEqual([flowTitle]);
  await expect.poll(() => focused(page), { timeout: 1_000 }).toMatchObject({ heading: true, inMain: true, text: "Hur vill du lägga till ljudet?" });
  expect(await scrollY(page), "a link starts at the top").toBe(0);
  expect(await scrolls(page), "one scroll, to the top").toEqual([[{ left: 0, top: 0, behavior: "instant" }]]);
  expect(blocking((await axe(page)).violations), "axe passes after a navigation").toEqual([]);
  await page.waitForTimeout(500);
  expect(await said(page), "said once").toEqual([flowTitle]);

  // Back: the list, where it was.
  await page.evaluate(() => (window.scrolls = []));
  await page.goBack();
  await expect(page.getByRole("link", { name: /Nämndmöte till rapport/ })).toBeVisible();
  await expect.poll(() => said(page), { timeout: 1_000 }).toEqual([flowTitle, LIST_TITLE]);
  await expect.poll(() => focused(page), { timeout: 1_000 }).toMatchObject({ heading: true, inMain: true, text: "Välj ett flöde" });
  expect(await scrollY(page), "Back lands where the list was").toBe(offset);
  expect(await scrolls(page), "one scroll, to where it was").toEqual([[{ left: 0, top: offset, behavior: "instant" }]]);
  expect(blocking((await axe(page)).violations), "axe passes after Back").toEqual([]);
});

test("a page whose code cannot be fetched is a page too: its own title, said once, and the focus in its heading", async ({ page, sentinel }) => {
  // The page's code: the dev server's module, or the built chunk. Gone before the list fetches it while it is read.
  const code = /\/(routes\/FlowPage\.tsx|assets\/FlowPage-[^/]+\.js)(\?|$)/;
  sentinel.expect({ console: /status of 404.*FlowPage/ }, { console: /A page could not be shown/ });
  await page.addInitScript(listen);
  await page.route(code, (route) => route.fulfill({ status: 404, body: "" }));
  await flows(page);
  await page.getByRole("link", { name: /Nämndmöte till rapport/ }).click();

  await expect(page.getByRole("heading", { name: "Sidan kunde inte visas." })).toBeVisible();
  const title = "Sidan kunde inte visas · Tal till text";
  await expect.poll(() => page.title(), { timeout: 1_000 }).toBe(title);
  await expect.poll(() => said(page), { timeout: 1_000 }).toEqual([title]);
  await expect.poll(() => focused(page), { timeout: 1_000 }).toMatchObject({ heading: true, inMain: true, text: "Sidan kunde inte visas." });
});

test("signing out: the sign-in page's title, announcement and heading, not the spinner's", async ({ page }) => {
  await page.addInitScript(listen);
  await flows(page);
  await page.route("**/api/auth/status", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.fulfill({ json: { authenticated: false, user: null } }).catch(() => undefined);
  });
  await page.getByRole("button", { name: /^Öppna konto för/ }).click();
  await page.getByRole("menuitem", { name: "Logga ut" }).click();
  await expect.poll(() => page.title(), { timeout: 1_000 }).toBe(LOGIN_TITLE);
  await expect(page.getByRole("status", { name: "Laddar" })).toBeVisible();
  expect(await said(page), "nothing is said over the spinner").toEqual([]);
  expect((await focused(page)).heading, "no focus in the spinner's heading").toBe(false);
  await expect(page.getByRole("button", { name: "Logga in med Eneo" })).toBeVisible();
  await expect.poll(() => said(page), { timeout: 1_000 }).toEqual([LOGIN_TITLE]);
  await expect.poll(() => focused(page), { timeout: 1_000 }).toMatchObject({ heading: true, inMain: true, text: "Du är utloggad" });
  expect(blocking((await axe(page)).violations), "axe passes on the sign-in page").toEqual([]);
});

test("a Tab pressed while the page is still loading: the shell it landed in is replaced, so the focus is given to the heading", async ({ page }) => {
  await page.addInitScript(listen);
  await flows(page);
  await delaySession(page, 1_500);
  await page.getByRole("link", { name: /Nämndmöte till rapport/ }).evaluate((link) => (link as HTMLElement).click());
  await expect(page.getByRole("status", { name: "Laddar" })).toBeVisible();
  // Tab from the page's start: the skip link, outside the main region.
  await page.keyboard.press("Tab");
  const person = await focused(page);
  expect(person.tag, "Tab went to a control").toBe("a");
  expect(person.inMain).toBe(false);
  await expect(page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" })).toBeVisible();
  const title = await page.title();
  await expect.poll(() => said(page), { timeout: 1_000 }).toEqual([title]);
  await page.waitForTimeout(500);
  // The gate replaced the shell the focus was in: the app took the focus away, so the app gives it back.
  await expect.poll(() => focused(page), { timeout: 1_000 }).toMatchObject({ heading: true, inMain: true });
});

test("a key that moves no focus is an action too: when the content comes the heading does not take the focus", async ({ page }) => {
  await page.addInitScript(listen);
  await flows(page);
  await delaySession(page, 1_500);
  await page.getByRole("link", { name: /Nämndmöte till rapport/ }).evaluate((link) => (link as HTMLElement).click());
  await expect(page.getByRole("status", { name: "Laddar" })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" })).toBeVisible();
  await expect.poll(() => said(page), { timeout: 1_000 }).toHaveLength(1);
  await page.waitForTimeout(500);
  expect((await focused(page)).heading, "no focus taken from a person who has acted").toBe(false);
});

test("a control the page focused itself keeps the focus, and the title is still said", async ({ page }) => {
  // The page takes the focus as its content appears, as a phase's view does with its heading (usePhaseHeading).
  await page.addInitScript(() => {
    let done = false;
    new MutationObserver(() => {
      const own = document.querySelector<HTMLElement>('main input[type="radio"], [role="main"] input[type="radio"]');
      if (own && !done) {
        done = true;
        own.focus();
      }
    }).observe(document, { subtree: true, childList: true });
  });
  await page.addInitScript(listen);
  await flows(page);
  await page.getByRole("link", { name: /Nämndmöte till rapport/ }).click();
  await expect(page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" })).toBeVisible();
  const title = await page.title();
  await expect.poll(() => said(page), { timeout: 1_000 }).toEqual([title]);
  await page.waitForTimeout(500);
  const now = await focused(page);
  expect(now, "the control the page focused is still focused").toMatchObject({ tag: "input", heading: false, inMain: true });
});

test("a change of the address's query alone is the page's own: no title, announcement, focus or scroll", async ({ page, sentinel }, info) => {
  sentinel.expect(NO_CONFIRMED_WORDS);
  await page.addInitScript(listen);
  await page.setViewportSize({ width: info.project.use.viewport!.width, height: 380 });
  await setup(page);
  const runs = page.locator("[data-open-run]");
  await expect(runs.first()).toBeVisible();
  const title = await page.title();
  const offset = await page.evaluate(() => {
    window.scrollTo(0, 150);
    window.scrolls = [];
    return Math.round(window.scrollY);
  });
  expect(offset, "the page scrolls in this window").toBeGreaterThan(50);
  const before = await focused(page);
  // The address's query changed under the page, as a Back or a link to the same path would.
  await clientNavigate(page, `${new URL(page.url()).pathname}?x=1`);
  await page.waitForTimeout(1_000);
  expect(await said(page), "a query alone is no navigation").toEqual([]);
  expect(await scrolls(page), "and scrolls nothing").toEqual([]);
  expect(await scrollY(page)).toBe(offset);
  expect(await page.title()).toBe(title);
  expect(await focused(page), "and moves no focus").toEqual(before);
  // The page writes it itself, as opening an earlier run does: replaced, not a navigation.
  await runs.first().evaluate((button) => (button as HTMLElement).click());
  await expect.poll(() => page.url(), { timeout: 5_000 }).toContain("run=");
  await page.waitForTimeout(1_000);
  expect(await said(page), "the page's own write is no navigation either").toEqual([]);
});

test("the three /inloggad states keep their own titles, and a navigation to one says it", async ({ page }) => {
  await page.addInitScript(listen);
  const TITLES = {
    "": "Inloggad igen · Tal till text",
    "?fel=utgangen": "Inloggningen har gått ut · Tal till text",
    "?fel=annan-anvandare": "Fel användare · Tal till text",
  };
  for (const [query, title] of Object.entries(TITLES)) {
    // As the first page: its own title, nothing said, nothing moved.
    await page.goto(`/inloggad${query}`);
    await expect.poll(() => page.title(), { timeout: 2_000 }).toBe(title);
    await page.waitForTimeout(400);
    expect(await said(page), `${query || "plain"}: a first load says nothing`).toEqual([]);
  }
  // As the page a navigation leads to: the page's title, said once, with the focus in its heading.
  await flows(page);
  for (const [query, title] of Object.entries(TITLES)) {
    await page.evaluate(() => (window.routeSaid.length = 0));
    await clientNavigate(page, `/inloggad${query}`);
    // The page's code may be fetched for the first time here.
    await expect.poll(() => said(page), { timeout: 5_000, message: `${query || "plain"}: the title is said` }).toEqual([title]);
    expect(await page.title(), `${query || "plain"}: the page's own title stands`).toBe(title);
    await expect.poll(() => focused(page), { timeout: 1_000 }).toMatchObject({ heading: true, inMain: true });
    // Back on the list, and said, before the next round starts counting.
    await clientNavigate(page, "/flows");
    await expect.poll(() => said(page), { timeout: 5_000 }).toContain(LIST_TITLE);
  }
});

test("a dialog that gives the focus back is not a navigation: nothing is said and the title stays", async ({ page }) => {
  await page.addInitScript(listen);
  await setup(page);
  await record(page, "Spela in");
  // The recording's title has the time in it.
  const titled = /^Spelar in .* · Tal till text$/;
  expect(await page.title()).toMatch(titled);
  const way = backLink(page);
  await way.click();
  const dialog = page.getByRole("alertdialog", { name: "Lämna sidan?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Stanna kvar" }).click();
  await expect(dialog).toBeHidden();
  await page.waitForTimeout(500);
  expect(await said(page), "staying is no navigation").toEqual([]);
  expect(await page.title()).toMatch(titled);
  expect(await focused(page), "the focus went back to the link").toMatchObject({ tag: "a" });
});

test("a run that no longer exists leaves the address and says so above a new start, so a reload does not ask again", async ({ page, sentinel }) => {
  // Eneo's answer for the run is a 404, which the browser reports in the console.
  sentinel.expect({ console: /status of 404.*\/runs\/00000000-0000-4000-8000-00000000dead\// });
  await page.goto(`/flows/${ids.flows.flow1}?run=00000000-0000-4000-8000-00000000dead`);
  await expect(page.getByRole("alert").filter({ hasText: "Körningen finns inte längre. Du kan starta en ny här." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" })).toBeVisible();
  expect(new URL(page.url()).searchParams.has("run")).toBe(false);
  // The run the person meant is likely among the flow's earlier runs: they are listed under the setup as usual.
  await expect(page.getByRole("heading", { name: "Tidigare körningar" })).toBeVisible();
});

test("the word that a linked run is gone does not follow the person into the recording", async ({ page, sentinel }, info) => {
  test.skip(info.project.name !== "laptop-1440-light", "behaviour, at one width");
  sentinel.expect({ console: /status of 404.*\/runs\/00000000-0000-4000-8000-00000000dead\// });
  await page.goto(`/flows/${ids.flows.flow1}?run=00000000-0000-4000-8000-00000000dead`);
  const gone = page.getByRole("alert").filter({ hasText: "Körningen finns inte längre" });
  await expect(gone).toBeVisible();
  await record(page, "Spela in");
  await expect(gone).toHaveCount(0);
});

test("an earlier run opened from the setup is an entry of its own: Back goes to the setup and its list, Forward to the run", async ({ page, sentinel }) => {
  sentinel.expect(NO_CONFIRMED_WORDS);
  await setup(page);
  // The finished run, named and dated by its form.
  await page.getByRole("region", { name: "Senaste körningar" }).getByRole("button", { name: /^Öppna, Styrelsemöte, möte 22 sep, / }).click();
  await expect(page.getByRole("heading", { name: "Dokumentet är klart" })).toBeVisible();

  await page.goBack();
  await expect(page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tidigare körningar" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`/flows/${ids.flows.flow1}`);
  expect(new URL(page.url()).searchParams.has("run")).toBe(false);

  await page.goForward();
  await expect(page.getByRole("heading", { name: "Dokumentet är klart" })).toBeVisible();

  // The run's entry loaded again, and Back to the setup while the flow is still being read: the setup stays, and its
  // address names no run, when the reads come in.
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let held = 0;
  await page.route(new RegExp(`/api/eneo/flows/${ids.flows.flow1}/(published|run-contract)/`), async (route) => {
    held += 1;
    await released;
    await route.fallback().catch(() => undefined);
  });
  await page.reload({ waitUntil: "commit" });
  await expect.poll(() => held, { message: "the flow and its contract are being read" }).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => ((window as unknown as { loaded: boolean }).loaded = true));
  await page.goBack({ waitUntil: "commit" });
  expect(new URL(page.url()).searchParams.has("run")).toBe(false);
  // The same page, still reading: Back loaded nothing anew.
  expect(await page.evaluate(() => (window as unknown as { loaded?: boolean }).loaded)).toBe(true);
  release();
  await expect(page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tidigare körningar" })).toBeVisible();
  await page.waitForTimeout(1_000);
  expect(new URL(page.url()).searchParams.has("run"), "the setup's address keeps no run").toBe(false);
  await expect(page.getByRole("heading", { name: "Dokumentet är klart" })).toHaveCount(0);
});

// An action on an earlier run opened from the setup, and Back to the setup before Eneo answers it: Eneo keeps what it did,
// and the answer takes neither the setup's address nor the place of a recording started there meanwhile.
for (const action of ["Försök igen", "Avbryt körningen"] as const) {
  test(`Back to the setup while ${action} waits for Eneo: the late answer leaves the setup and a new recording where they are`, async ({ page, sentinel }, info) => {
    test.skip(info.project.name !== "laptop-1440-light", "history and requests, at one width");
    sentinel.expect(NO_CONFIRMED_WORDS);
    const retry = action === "Försök igen";
    if (!retry) {
      // A run still going among the earlier ones, which the person follows from the list.
      await page.route(new RegExp(`/api/eneo/flows/${ids.flows.flow1}/runs/\\?`), async (route) => {
        const response = await route.fetch();
        const { items, ...list } = await response.json();
        const going = { id: ids.runs.running, flow_id: ids.flows.flow1, status: "running", created_at: "2026-09-24T09:00:00Z" };
        await route.fulfill({ response, json: { ...list, items: [going, ...items] } });
      });
    }
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    await page.route(retry ? "**/retry/" : "**/cancel/", async (route) => {
      held = true;
      await released;
      // The stub has no cancel: Eneo's answer to one is the run, stopping.
      await (retry ? route.fallback() : route.fulfill({ json: { id: ids.runs.running, flow_id: ids.flows.flow1, status: "cancelled" } })).catch(
        () => undefined,
      );
    });
    await setup(page);
    await page.getByRole("region", { name: "Senaste körningar" }).getByRole("listitem").filter({ hasText: retry ? "Misslyckades" : "Pågår" }).getByRole("button").click();
    if (retry) {
      await page.getByRole("button", { name: "Försök igen" }).click();
    } else {
      await page.getByRole("button", { name: "Avbryt körningen" }).click();
      await page.getByRole("alertdialog", { name: "Avbryta körningen?" }).getByRole("button", { name: "Avbryt körningen" }).click();
    }
    await expect.poll(() => held, { message: `${action} is on its way to Eneo` }).toBe(true);

    await page.goBack();
    await expect(page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" })).toBeVisible();
    await record(page, "Spela in");
    const answered = page.waitForResponse(retry ? "**/retry/" : "**/cancel/");
    release();
    await answered;
    // Time for what the answer would start: the address, the run's view, its first status read.
    await page.waitForTimeout(1_500);
    expect(new URL(page.url()).searchParams.has("run"), "the setup's address names no run").toBe(false);
    await expect(page.getByRole("toolbar", { name: "Inspelningen" }).getByRole("button", { name: "Stoppa" }), "the recording's controls stay").toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Spelar in." })).toBeAttached();
  });
}

test("Försök igen answered while the failed run is still shown opens the run Eneo continues it in", async ({ page, sentinel }, info) => {
  test.skip(info.project.name !== "laptop-1440-light", "history and requests, at one width");
  sentinel.expect(NO_CONFIRMED_WORDS);
  await setup(page);
  await page.getByRole("region", { name: "Senaste körningar" }).getByRole("listitem").filter({ hasText: "Misslyckades" }).getByRole("button").click();
  await page.getByRole("button", { name: "Försök igen" }).click();
  await expect(page.getByRole("heading", { name: "Dokumentet skapas", level: 1 })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("run"), "the address names the new run").not.toBe(ids.runs.failed);
});

test("a run waiting for review opens the setup's latest runs, and Granska opens Vem är vem? with its heading focused", async ({ page, sentinel }) => {
  sentinel.expect(NO_CONFIRMED_WORDS);
  await page.goto(`/flows/${ids.flows.flow2}`);
  // The page's status region says it once (aria.spec.ts).
  const latest = page.getByRole("region", { name: "Senaste körningar" });
  await expect(latest.getByRole("listitem").first()).toContainText("Väntar på granskning");
  await expect(latest).toContainText("En körning som väntar på granskning avbryts om den inte granskas i tid.");
  await latest.getByRole("button", { name: /^Granska, körningen / }).click();
  const heading = page.getByRole("heading", { name: "Vem är vem?", level: 1 });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
});

test("Ny inspelning after a run opened by its address draws the setup with the runs read while the run was shown", async ({ page, sentinel }) => {
  sentinel.expect(NO_CONFIRMED_WORDS);
  // A page opened at a run's address reads no runs on its load: they are read while the run's view is on the page.
  const runs = new RegExp(`/api/eneo/flows/${ids.flows.flow1}/runs/\\?`);
  const read = page.waitForResponse(runs);
  await page.goto(`/flows/${ids.flows.flow1}?run=${ids.runs.done}`);
  await expect(page.getByRole("heading", { name: "Dokumentet är klart" })).toBeVisible();
  await read;
  // A read started from here on is never answered: the setup is drawn from what was read, or not at all.
  let later = 0;
  await page.route(runs, () => void (later += 1));
  await startOver(page);
  await expect(page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Senaste körningar" }).getByRole("listitem").first()).toContainText("Styrelsemöte");
  expect(later, "going back reads nothing that would fill a row in above the form").toBe(0);
});

// A read the run's view started that answers once the setup is back: it adds a run, at the working card's end only.
for (const back of ["Back", "Ny inspelning"] as const) {
  test(`a read of the runs that lands after ${back} changes the whole list, never the rows above the form`, async ({ page, sentinel }) => {
    sentinel.expect(NO_CONFIRMED_WORDS);
    await setup(page);
    const latest = page.getByRole("region", { name: "Senaste körningar" });
    const choice = page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" });
    const rows = await latest.getByRole("listitem").allTextContents();
    const at = () => choice.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    const before = await at();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(new RegExp(`/api/eneo/flows/${ids.flows.flow1}/runs/\\?`), async (route) => {
      await held;
      const response = await route.fetch();
      const { items, ...list } = await response.json();
      const started = { id: ids.runs.running, flow_id: ids.flows.flow1, status: "running", created_at: "2026-09-24T09:30:00Z" };
      await route.fulfill({ response, json: { ...list, items: [started, ...items] } }).catch(() => undefined);
    });
    await latest.getByRole("button", { name: /^Öppna, Styrelsemöte, / }).click();
    await expect(page.getByRole("heading", { name: "Dokumentet är klart" })).toBeVisible();
    if (back === "Back") await page.goBack();
    else await startOver(page);
    await expect(choice).toBeVisible();
    release();
    await expect(page.getByRole("region", { name: "Tidigare körningar" }).getByRole("listitem"), "the whole list has the new run").toHaveCount(5);
    expect(await latest.getByRole("listitem").allTextContents(), "the rows above the form as the setup opened").toEqual(rows);
    expect(await at(), "the form where it was").toBe(before);
  });
}

test("a flow that must be published again says its heading once: the line under it says what to do", async ({ page, sentinel }) => {
  sentinel.expect({ console: /status of 409.*\/published\// }, { console: /status of 409.*\/run-contract\// });
  await page.goto(`/flows/${ids.flows.flow4}`);
  const title = page.getByRole("heading", { level: 1 });
  await expect(title).toHaveText("Flödet kan inte användas just nu.");
  const line = title.locator("xpath=following-sibling::p[1]");
  await expect(line).not.toContainText("Flödet kan inte användas just nu.");
  await expect(line).toContainText("publicera det på nytt");
});
