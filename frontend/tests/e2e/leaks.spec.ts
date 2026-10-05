/**
 * An overlay that is opened and closed leaves nothing behind: no DOM nodes, no event listeners, no memory.
 * Chromium's own counters, read after a garbage collection, before and after 40 openings of each overlay.
 * A leak grows with every cycle (a listener an effect never removes, a portal that is never unmounted), so it
 * would show as about 40. A new overlay surface is added here in the phase that ports it.
 */
import { type CDPSession, type Locator, type Page } from "@playwright/test";
import { expect, test } from "./gate";
import { backLink, chooseMode, open, record, result, reviewEditor, run, setup, stop } from "./screens";
import ids from "../fixtures/ids.json";

test.beforeEach(({}, info) => test.skip(info.project.name !== "laptop-1440-light", "one width is enough; Chromium's counters"));
// Playwright's trace snapshots add their own nodes and listeners to the page being counted.
test.use({ trace: "off" });

const CYCLES = 40;
// The cycles before the baseline, for what an overlay legitimately keeps (a portal root, a lazy chunk, a cache)
// and for the browser's own warm-up: after one, a dialog's heap still grew by 1.1 MB over the next 40, after five by 0.5 MB.
const WARM_UP = 5;
// What the 40 openings together may leave. Never raised to make a test pass: a number above it is a leak to find.
const SLACK = { nodes: 20, listeners: 20, heapMB: 1.5 };

type Overlay = {
  /** The overlay is meant to leak: the spec must see it leak (its counts above the thresholds), which is what shows that it can. */
  leaks?: true;
  /** Where the overlay is opened, once; the foundation page when there is none. */
  go?: (page: Page) => Promise<unknown>;
  show: (page: Page) => Promise<unknown>;
  shown: (page: Page) => Locator;
  hide: (page: Page) => Promise<unknown>;
};

/** How a page mounts a confirmation (routes/dev/DialogLeakFixture): once, for each opening, and a dialog that really leaks. */
const dialogLeaks = async (page: Page) => {
  await open(page, "/dev/dialog-leak");
  await expect(page.getByRole("heading", { name: "Dialogläckor" })).toBeVisible();
};

/** The warning opens once for each end of the login, so each opening is an answer that ends more than a minute from the last. */
let loginEndsIn = 200;

/** A run paused for review, its transcript read: where the naming dialog opens. */
async function reviewPage(page: Page) {
  await run(page, ids.runs.review, ids.flows.flow2);
  await expect(page.getByRole("button", { name: /^Spela från/ }).first()).toBeVisible();
}

const OVERLAYS: Record<string, Overlay> = {
  // The foundation page's own single-item menu: the design system's DropdownMenu, not the module's.
  "foundation menu": {
    show: (page) => page.getByRole("button", { name: "Konto" }).click(),
    shown: (page) => page.getByRole("menu"),
    hide: (page) => page.keyboard.press("Escape"),
  },
  // The module's account menu, as every page has it: the avatar, the colour mode and Logga ut (only it has that item).
  "account menu": {
    go: async (page) => {
      await open(page, "/flows");
      await expect(page.getByRole("heading", { name: "Välj ett flöde" })).toBeVisible();
    },
    show: (page) => page.getByRole("button", { name: /^Öppna konto för/ }).click(),
    shown: (page) => page.getByRole("menuitem", { name: "Logga ut" }),
    hide: (page) => page.keyboard.press("Escape"),
  },
  "speaker picker": {
    show: (page) => page.getByRole("combobox", { name: "Talare" }).click(),
    shown: (page) => page.getByRole("option", { name: "Erik Lund" }),
    hide: (page) => page.keyboard.press("Escape"),
  },
  // The review page's own overlays: the naming dialog, and the name list inside it (a popover of the top layer).
  "naming dialog": {
    go: (page) => reviewPage(page),
    show: (page) => page.getByRole("button", { name: "Namnge talarna" }).click(),
    shown: (page) => page.getByRole("dialog", { name: "Namnge talarna" }),
    hide: (page) => page.keyboard.press("Escape"),
  },
  "name list": {
    go: async (page) => {
      await reviewPage(page);
      await page.getByRole("button", { name: "Namnge talarna" }).click();
    },
    show: (page) => page.getByRole("combobox", { name: "Vem är Talare 2?" }).click(),
    shown: (page) => page.getByRole("listbox", { name: "Förslag: Vem är Talare 2?" }),
    hide: (page) => page.keyboard.press("Escape"),
  },
  // The speaker-review editor, on the development page that carries it: a passage marked and let go, the list of
  // speakers for the marked words, and the field that corrects their text.
  "marked words": {
    go: reviewEditor,
    show: (page) => page.getByRole("button", { name: "Markera stycket: Förslag: Agne" }).click(),
    shown: (page) => page.getByRole("group", { name: "Markerade ord" }),
    hide: (page) => page.getByRole("button", { name: "Avmarkera" }).click(),
  },
  "text correction": {
    go: async (page) => {
      await reviewEditor(page);
      await page.getByRole("button", { name: "Nästa passage som behöver talarbeslut" }).click();
    },
    show: (page) => page.getByRole("button", { name: "Rätta text", exact: true }).click(),
    shown: (page) => page.getByRole("textbox", { name: "Rätta markerad text" }),
    hide: (page) => page.getByRole("button", { name: "Avbryt", exact: true }).click(),
  },
  // "Ändra talare" on a passage of the transcript: a popover of the page, one per passage, opened from the passage's name.
  // The design system's focus handling (useFocusTrap) keeps the last element focused inside a popover, and with it that
  // popover's closed form (88 nodes, 12 listeners), until the popover is opened again: one form per popover, never one per
  // opening. It exists only if focus got inside before the popover was closed, so the opening waits for focus: else a
  // warm-up that closed it too soon would be measured without that form and the 40 openings with it, as 88 nodes.
  "change-speaker popover": {
    go: (page) => reviewPage(page),
    show: async (page) => {
      await page.getByRole("button", { name: "Anna Berg, ändra talare" }).first().click();
      await expect(page.getByRole("dialog", { name: "Ändra talare" }).getByRole("radio").first()).toBeFocused();
    },
    shown: (page) => page.getByRole("dialog", { name: "Ändra talare" }),
    hide: (page) => page.keyboard.press("Escape"),
  },
  "speaker list of the editor": {
    go: async (page) => {
      await reviewEditor(page);
      await page.getByRole("button", { name: "Nästa passage som behöver talarbeslut" }).click();
    },
    show: (page) => page.getByRole("combobox", { name: "Tilldela talare" }).click(),
    shown: (page) => page.getByRole("option", { name: "Karin", exact: true }),
    hide: (page) => page.keyboard.press("Escape"),
  },
  // A required dialog stays on Escape: it is closed with its own button.
  dialog: {
    show: (page) => page.getByRole("button", { name: "Primär" }).click(),
    shown: (page) => page.getByRole("alertdialog", { name: "Du behöver logga in igen" }),
    hide: (page) => page.getByRole("button", { name: "Stäng" }).click(),
  },
  "alert dialog": {
    show: (page) => page.getByRole("button", { name: "Liten" }).click(),
    shown: (page) => page.getByRole("alertdialog", { name: "Lämna sidan?" }),
    hide: (page) => page.getByRole("button", { name: "Stanna kvar" }).click(),
  },
  // The result's own overlays, on the page that owns them. A PDF opens in a dialog on a laptop's width; Escape closes it
  // from its title, where focus starts.
  "pdf preview": {
    go: (page) => result(page),
    show: (page) => page.getByRole("button", { name: /^Öppna Protokoll .*\.pdf$/ }).click(),
    shown: (page) => page.getByRole("dialog"),
    hide: (page) => page.keyboard.press("Escape"),
  },
  // Fler alternativ is under a laptop's width, and holds Dela where the browser can share (headless Chromium has no
  // share sheet, so a stand-in is defined before the page loads).
  "more options": {
    go: async (page) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript(() => Object.defineProperty(navigator, "share", { value: async () => undefined, configurable: true }));
      await run(page, ids.runs.plain);
      await expect(page.getByRole("heading", { name: "Texten är klar" })).toBeVisible();
    },
    show: (page) => page.getByRole("button", { name: "Fler alternativ" }).click(),
    shown: (page) => page.getByRole("menu"),
    hide: (page) => page.keyboard.press("Escape"),
  },
  "alert dialog mounted once": {
    go: dialogLeaks,
    show: (page) => page.getByRole("button", { name: "Monterad en gång" }).click(),
    shown: (page) => page.getByRole("alertdialog", { name: "Lämna sidan?" }),
    hide: (page) => page.getByRole("button", { name: "Stanna kvar" }).click(),
  },
  "alert dialog mounted for each opening": {
    go: dialogLeaks,
    show: (page) => page.getByRole("button", { name: "Monterad vid varje öppning" }).click(),
    shown: (page) => page.getByRole("alertdialog", { name: "Lämna sidan?" }),
    hide: (page) => page.getByRole("button", { name: "Stanna kvar" }).click(),
  },
  "dialog that keeps what it mounted": {
    leaks: true,
    go: dialogLeaks,
    show: (page) => page.getByRole("button", { name: "Läckande dialog" }).click(),
    shown: (page) => page.getByRole("alertdialog", { name: "Dialog som läcker" }),
    hide: (page) => page.getByRole("button", { name: "Stäng dialogen som läcker" }).click(),
  },
  // The module's own overlays, on the pages that own them.
  "session warning": {
    go: async (page) => {
      await page.route("**/api/auth/status", (route) =>
        route.fulfill({
          json: {
            authenticated: true,
            user: { id: "user-1", email: "erik.lund@sundsvall.se", username: "Erik Lund" },
            session_ends_in: loginEndsIn,
          },
        }),
      );
      await open(page, "/flows");
      await expect(page.getByRole("alertdialog", { name: "Du loggas snart ut" })).toBeVisible();
      await page.keyboard.press("Escape");
    },
    show: (page) => {
      loginEndsIn = loginEndsIn === 200 ? 290 : 200;
      return page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    },
    shown: (page) => page.getByRole("alertdialog", { name: "Du loggas snart ut" }),
    hide: (page) => page.keyboard.press("Escape"),
  },
  // A finished recording is audio the page holds, so leaving asks first; nothing on the page moves while it waits.
  "leave question": {
    go: async (page) => {
      await setup(page);
      await record(page, "Spela in");
      await stop(page);
    },
    show: (page) => backLink(page).click(),
    shown: (page) => page.getByRole("alertdialog", { name: "Lämna sidan?" }),
    hide: (page) => page.getByRole("button", { name: "Stanna kvar" }).click(),
  },
  // A popover of the setup page: the list of microphones (a bottom sheet on a touch screen, not counted here).
  "microphone picker": {
    go: async (page) => {
      await setup(page);
      await chooseMode(page, "Spela in");
    },
    show: (page) => page.getByRole("combobox", { name: "Mikrofon" }).click(),
    shown: (page) => page.getByRole("listbox"),
    hide: (page) => page.keyboard.press("Escape"),
  },
  // A page dialog on the page that owns it: the run's own view while it runs.
  "cancel question": {
    go: (page) => run(page, ids.runs.running),
    show: (page) => page.getByRole("button", { name: "Avbryt körningen" }).click(),
    shown: (page) => page.getByRole("alertdialog", { name: "Avbryta körningen?" }),
    hide: (page) => page.getByRole("button", { name: "Kör vidare" }).click(),
  },
  // The recording's own question, on the ready state that owns it: it adds the part sources and the player's listeners.
  "delete question": {
    go: async (page) => {
      await setup(page);
      await record(page, "Spela in");
      await stop(page);
    },
    show: (page) => page.getByRole("button", { name: "Ta bort", exact: true }).click(),
    shown: (page) => page.getByRole("alertdialog", { name: "Ta bort inspelningen?" }),
    hide: (page) => page.getByRole("button", { name: "Avbryt" }).click(),
  },
};

/** The page's DOM nodes, event listeners and used JS heap once everything unreachable is collected. */
async function counters(cdp: CDPSession) {
  await cdp.send("HeapProfiler.collectGarbage");
  const { nodes, jsEventListeners } = await cdp.send("Memory.getDOMCounters");
  const { usedSize } = await cdp.send("Runtime.getHeapUsage");
  return { nodes, listeners: jsEventListeners, heapMB: usedSize / 1024 ** 2 };
}

/** The counters once the page has stopped changing by itself: a dev server's own client and the page's lazy chunks settle after the load. */
async function settledCounters(page: Page, cdp: CDPSession) {
  let previous = await counters(cdp);
  for (let quiet = 0; quiet < 4; ) {
    await page.waitForTimeout(250);
    const now = await counters(cdp);
    quiet = now.nodes === previous.nodes && now.listeners === previous.listeners ? quiet + 1 : 0;
    previous = now;
  }
  return previous;
}

async function cycle(page: Page, overlay: Overlay) {
  await overlay.show(page);
  await expect(overlay.shown(page)).toBeVisible();
  await overlay.hide(page);
  await expect(overlay.shown(page)).toBeHidden();
  // Chromium keeps the element last under the pointer after it is removed, and with it everything removed with it,
  // until the pointer moves: one dialog's nodes (25 to 39) that an overlay mounted for each opening leaves behind
  // when it was closed by a click, and that a person's pointer going elsewhere releases. Not the overlay's leak.
  await page.mouse.move(2, 2);
}

for (const [name, overlay] of Object.entries(OVERLAYS)) {
  test(overlay.leaks ? `the guard sees the ${name} leave something behind after ${CYCLES} openings` : `the ${name} leaves nothing behind after ${CYCLES} openings`, async ({ page }, info) => {
    // A dialog's animations make a cycle last about a second.
    test.setTimeout(180_000);
    if (overlay.go) await overlay.go(page);
    else {
      await open(page, "/dev/foundation");
      await expect(page.getByRole("heading", { name: "Grundkontroll" })).toBeVisible();
    }
    const cdp = await page.context().newCDPSession(page);

    for (let i = 0; i < WARM_UP; i++) await cycle(page, overlay);
    const warm = await settledCounters(page, cdp);
    for (let i = 0; i < CYCLES; i++) await cycle(page, overlay);
    const after = await counters(cdp);

    const grew = { nodes: after.nodes - warm.nodes, listeners: after.listeners - warm.listeners, heapMB: after.heapMB - warm.heapMB };
    info.annotations.push({ type: "leak", description: `warm ${JSON.stringify(warm)}, after ${CYCLES} openings ${JSON.stringify(after)}, grew ${JSON.stringify(grew)}` });
    if (overlay.leaks) {
      // The control: its fixture keeps what it mounted. It passes only by finishing every opening and seeing the nodes and the
      // listeners grow past the thresholds the other overlays must stay under, so a fixture that never shows cannot satisfy it.
      expect(grew.nodes, `${CYCLES} openings of the ${name} left ${grew.nodes} DOM nodes: the guard must see more than ${SLACK.nodes}`).toBeGreaterThan(SLACK.nodes);
      expect(grew.listeners, `${CYCLES} openings of the ${name} left ${grew.listeners} event listeners: the guard must see more than ${SLACK.listeners}`).toBeGreaterThan(SLACK.listeners);
      return;
    }
    expect.soft(grew.nodes, `${CYCLES} openings of the ${name} left ${grew.nodes} DOM nodes (the most allowed is ${SLACK.nodes})`).toBeLessThanOrEqual(SLACK.nodes);
    expect.soft(grew.listeners, `${CYCLES} openings of the ${name} left ${grew.listeners} event listeners (the most allowed is ${SLACK.listeners})`).toBeLessThanOrEqual(SLACK.listeners);
    expect.soft(grew.heapMB, `${CYCLES} openings of the ${name} grew the JS heap by ${grew.heapMB.toFixed(2)} MB (the most allowed is ${SLACK.heapMB} MB)`).toBeLessThanOrEqual(SLACK.heapMB);
  });
}
