/**
 * An overlay that is opened and closed leaves nothing behind: no DOM nodes, no event listeners, no memory.
 * Chromium's own counters, read after a garbage collection, before and after 40 openings of each overlay.
 * A leak grows with every cycle (a listener an effect never removes, a portal that is never unmounted), so it
 * would show as about 40. A new overlay surface is added here in the phase that ports it.
 */
import { expect, test, type CDPSession, type Locator, type Page } from "@playwright/test";
import { open, result, run } from "./screens";

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
  /** Where the overlay is opened, once; the foundation page when there is none. */
  go?: (page: Page) => Promise<unknown>;
  show: (page: Page) => Promise<unknown>;
  shown: (page: Page) => Locator;
  hide: (page: Page) => Promise<unknown>;
};

const OVERLAYS: Record<string, Overlay> = {
  "account menu": {
    show: (page) => page.getByRole("button", { name: "Konto" }).click(),
    shown: (page) => page.getByRole("menu"),
    hide: (page) => page.keyboard.press("Escape"),
  },
  "speaker picker": {
    show: (page) => page.getByRole("combobox", { name: "Talare" }).click(),
    shown: (page) => page.getByRole("option", { name: "Erik Lund" }),
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
      await run(page, "run-plain");
      await expect(page.getByRole("heading", { name: "Texten är klar" })).toBeVisible();
    },
    show: (page) => page.getByRole("button", { name: "Fler alternativ" }).click(),
    shown: (page) => page.getByRole("menu"),
    hide: (page) => page.keyboard.press("Escape"),
  },
};

/** The page's DOM nodes, event listeners and used JS heap once everything unreachable is collected. */
async function counters(cdp: CDPSession) {
  await cdp.send("HeapProfiler.collectGarbage");
  const { nodes, jsEventListeners } = await cdp.send("Memory.getDOMCounters");
  const { usedSize } = await cdp.send("Runtime.getHeapUsage");
  return { nodes, listeners: jsEventListeners, heapMB: usedSize / 1024 ** 2 };
}

/** The counters once the page has stopped changing by itself: `next dev` builds its own indicator after the load. */
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
}

for (const [name, overlay] of Object.entries(OVERLAYS)) {
  test(`the ${name} leaves nothing behind after ${CYCLES} openings`, async ({ page }, info) => {
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
    expect.soft(grew.nodes, `${CYCLES} openings of the ${name} left ${grew.nodes} DOM nodes (the most allowed is ${SLACK.nodes})`).toBeLessThanOrEqual(SLACK.nodes);
    expect.soft(grew.listeners, `${CYCLES} openings of the ${name} left ${grew.listeners} event listeners (the most allowed is ${SLACK.listeners})`).toBeLessThanOrEqual(SLACK.listeners);
    expect.soft(grew.heapMB, `${CYCLES} openings of the ${name} grew the JS heap by ${grew.heapMB.toFixed(2)} MB (the most allowed is ${SLACK.heapMB} MB)`).toBeLessThanOrEqual(SLACK.heapMB);
  });
}
