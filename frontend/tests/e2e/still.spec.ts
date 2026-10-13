/**
 * What is on screen stands still when an answer arrives. Each page is opened by its address with the module's answers
 * handed to it one at a time, in the order it asked for them: an answer is fetched at once and kept until the page has
 * stood still after the one before, and what is on screen (controls, headings, text, pictures) is measured before and
 * after each. Something that was on screen before an answer and has moved after it fails the page: what arrives late
 * (a button added when its file is read, details read after the card they stand above) must have its place from the
 * first draw, or it moves what a finger is on its way to and what an eye is reading.
 *
 * The clock does not decide the result. The answers come in the page's own order, each is whole before it is handed
 * over, the page is measured when its document has stopped changing, and nothing is pressed: a fast machine and a slow
 * one take the same steps. A page reached by a press is not here, because the press and the answers would race; what
 * a press sets in motion has its own tests (preview-actions.spec.ts holds one answer and measures one region). What
 * is animating is measured when it rests.
 */
import { type Page, type TestInfo } from "@playwright/test";
import { expect, test } from "./gate";
import { STATES, run } from "./screens";
import ids from "../fixtures/ids.json";

// One phone, one tablet and one laptop: the three layouts a late answer can move differently.
const LAYOUTS = ["phone-390-light", "tablet-portrait", "laptop-1440-light"];
// Less than this is a rounding of the layout, not a move.
const MOVED_PX = 4;

/** The gate's states that are reached by their address alone: every page of the module, as it opens. */
const BY_ADDRESS = [
  "signin-sso",
  "signin-error",
  "signin-unreachable",
  "flows-unreachable",
  "flow-list",
  "flow-list-error",
  "signed-in-again",
  "session-warning",
  "signed-out",
  "setup",
  "setup-speakers-blocked",
  "setup-speakers-unlabelled",
  "flow-gone",
  "flow-republish-required",
  "run-progress",
  "result",
  "result-table",
  "result-empty",
  "result-regenerate",
  "result-file-backed-text",
  "result-without-transcript",
  "review",
];

type Arrival = { name: string; go: (page: Page, info: TestInfo) => Promise<unknown> };
const ARRIVALS: Arrival[] = [
  ...BY_ADDRESS.map((name) => {
    const state = STATES.find((candidate) => candidate.name === name);
    if (!state) throw new Error(`still.spec.ts: no state named ${name} in screens.ts`);
    return state;
  }),
  // The gate's own failure state goes on to press "Visa teknisk information"; this is the page as it opens.
  {
    name: "failure",
    go: async (page) => {
      await run(page, ids.runs.failed);
      await expect(page.getByRole("heading", { name: "Dokumentet kunde inte skapas" })).toBeVisible();
    },
  },
];

/**
 * Moves that are left, each one answer on one page: why it is left and the bead that owns it. An entry must still
 * happen: when the page stands still, the line goes.
 */
const KNOWN: { page: string; when: RegExp; why: string }[] = [
  {
    page: "review",
    when: /moved 57 px down .* when GET \S+\/transcript-corrections\/ answered$/,
    why: "the speakers' list is drawn before the saved corrections that add a speaker to it are read (bead stt-5db.1)",
  },
  {
    page: "result-regenerate",
    when: /moved \d+ px down .* when GET \S+\/transcript-corrections\/ answered$/,
    why: "the notice that the document is older than the corrections arrives above the document (bead stt-5db.2)",
  },
];

type Anchor = { id: number; name: string; x: number; y: number; onScreen: boolean };
type Measure = { anchors: Anchor[]; presses: number };
type Still = { measure: () => Measure; quiet: () => Promise<void> };

/** In the page: numbers what it has measured so an element is compared with itself, counts presses, and knows when the document rests. */
function watch() {
  const state = { presses: 0, next: 1, changed: performance.now() };
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) {
    document.addEventListener(type, () => void (state.presses += 1), { capture: true, passive: true });
  }
  const observe = () =>
    new MutationObserver(() => void (state.changed = performance.now())).observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["hidden", "open"],
    });
  if (document.documentElement) observe();
  else document.addEventListener("readystatechange", observe, { once: true });

  const controls =
    'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="radio"], [role="switch"], [role="checkbox"], [role="menuitem"]';
  const content = "h1, h2, h3, h4, h5, h6, p, li, dt, dd, th, td, label, img, video, canvas";
  const still: Still = {
    // The document has not changed for a moment (five frames' worth), or a second and a half has passed: a page that
    // never rests is measured as it is.
    quiet: () =>
      new Promise<void>((done) => {
        const began = performance.now();
        const look = () => {
          const now = performance.now();
          if (now - state.changed >= 80 || now - began >= 1500) done();
          else requestAnimationFrame(look);
        };
        requestAnimationFrame(() => requestAnimationFrame(look));
      }),
    measure: () => {
      // What is in motion is on its way somewhere: its place is measured when it rests.
      const moving = document.getAnimations().flatMap((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        return animation.playState === "running" && target ? [target] : [];
      });
      const anchors: Anchor[] = [];
      for (const element of document.querySelectorAll<HTMLElement>(`${controls}, ${content}`)) {
        if (!element.checkVisibility({ visibilityProperty: true })) continue;
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        if (moving.some((target) => target.contains(element))) continue;
        const numbered = element as HTMLElement & { __still?: number };
        numbered.__still ??= state.next++;
        anchors.push({
          id: numbered.__still,
          name: (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 50) || element.tagName.toLowerCase(),
          x: Math.round(box.x),
          y: Math.round(box.y),
          onScreen: box.bottom > 0 && box.top < window.innerHeight && box.right > 0 && box.left < window.innerWidth,
        });
      }
      return { anchors, presses: state.presses };
    },
  };
  (window as unknown as { __still: Still }).__still = still;
}

/** What is on screen once the document rests; null while the page is between two documents. */
const look = (page: Page): Promise<Measure | null> =>
  page
    .evaluate(async () => {
      const still = (window as unknown as { __still?: Still }).__still;
      if (!still) return null;
      await still.quiet();
      return still.measure();
    })
    .catch(() => null);

for (const arrival of ARRIVALS) {
  test(`${arrival.name} stands still when an answer arrives`, async ({ page }, info) => {
    test.skip(!LAYOUTS.includes(info.project.name), "one phone, one tablet and one laptop");
    test.setTimeout(180_000);

    // The answers, in the order the page asked for them.
    const asked: { path: string; fetched: Promise<void>; hand: () => void }[] = [];
    await page.addInitScript(watch);
    // Registered first, so it is asked last: an answer a state makes up itself is not kept, one it lets through is.
    await page.route(/\/api\//, async (route) => {
      const request = route.request();
      // What the page reads itself. A player's audio and a frame's file are the browser's own reads, in pieces.
      if (!["fetch", "xhr"].includes(request.resourceType())) return route.fallback();
      let hand!: () => void;
      const handed = new Promise<void>((resolve) => (hand = resolve));
      const response = route.fetch().catch(() => null);
      asked.push({ path: `${request.method()} ${new URL(request.url()).pathname}`, fetched: response.then(() => undefined), hand });
      const [answer] = await Promise.all([response, handed]);
      await (answer ? route.fulfill({ response: answer }) : route.fallback()).catch(() => undefined);
    });

    const moves: string[] = [];
    let pressed = false;
    let before: Measure | null = null;
    const compare = (after: Measure | null, cause: string) => {
      const was = before;
      before = after;
      if (after && after.presses > 0) pressed = true;
      if (!was || !after) return;
      for (const now of after.anchors) {
        const then = was.anchors.find((anchor) => anchor.id === now.id);
        if (!then?.onScreen || (Math.abs(now.y - then.y) < MOVED_PX && Math.abs(now.x - then.x) < MOVED_PX)) continue;
        moves.push(`"${now.name}" moved ${now.y - then.y} px down and ${now.x - then.x} px right ${cause}`);
      }
    };

    let arrived = false;
    const arriving = arrival.go(page, info).finally(() => (arrived = true));
    // A failure of the page's own steps is the test's failure, once the loop below has handed its answers over.
    arriving.catch(() => undefined);
    while (!arrived || asked.length > 0) {
      const answer = asked.shift();
      if (!answer) {
        await page.waitForTimeout(20);
        continue;
      }
      await answer.fetched;
      compare(await look(page), "by itself, between two answers");
      answer.hand();
      compare(await look(page), `when ${answer.path} answered`);
    }
    await arriving;
    compare(await look(page), "by itself, after the last answer");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    for (const answer of asked) answer.hand();

    expect(pressed, "this page was reached by a press: it does not belong among the pages opened by their address").toBe(false);
    const declared = KNOWN.filter((known) => known.page === arrival.name);
    for (const known of declared) {
      info.annotations.push({ type: "known", description: known.why });
      expect(moves.some((move) => known.when.test(move)), `listed as still moving (${known.why}), and it stood still: take it off the list`).toBe(true);
    }
    const unknown = [...new Set(moves)].filter((move) => !declared.some((known) => known.when.test(move)));
    expect(unknown.slice(0, 6), "what moved on screen when no one pressed anything").toEqual([]);
  });
}
