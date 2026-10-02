/**
 * A short screen (a phone on its side, 200 % zoom) is wide and has little height to give the recording: the person must
 * still see that recording is on (the dot and the timer), reach Pausa and Stoppa without scrolling past anything, read
 * what warns of a lost meeting, and with Strömma keep a text to read, however long it grows. The room for the text is
 * counted in its lines, and the page is set in the widest font a platform falls back to: a pixel count passes on one
 * platform's font and fails on another's.
 */
import { expect, test, type Page } from "@playwright/test";
import { longLiveText } from "./live-relay";
import { record, setup } from "./screens";

test.beforeEach(({}, info) => test.skip(info.project.name !== "phone-390-light", "the window is set below"));

/**
 * The width of `reference` at 16 px in DejaVu Sans, the font a Linux runner falls back to for our font stack and the
 * widest sans of the common platforms (a tenth wider than macOS's and Windows's). A narrower font is set wider, by
 * letter-spacing, up to that width; DejaVu itself is left as it is. So the page has the same words in the same width on
 * every platform, and a layout that holds by a pixel in a narrower font is found out.
 */
const DEJAVU = {
  reference: "Vi hör inget från mikrofonen. Kontrollera att den inte är avstängd. Det finns lite lagringsutrymme kvar på enheten.",
  width: 919,
};

const SIZES = [
  { width: 844, height: 390 },
  { width: 640, height: 400 },
  { width: 568, height: 320 },
] as const;

/** What of the recording a person must see, each as a problem when it is not wholly in the window and uncovered. */
const seen = (page: Page) =>
  page.evaluate(() => {
    const [vw, vh] = [innerWidth, innerHeight];
    const problem = (name: string, el: Element | null | undefined) => {
      if (!el) return `${name}: missing`;
      const r = el.getBoundingClientRect();
      if (r.top < -0.5 || r.bottom > vh + 0.5 || r.left < -0.5 || r.right > vw + 0.5) return `${name}: outside the ${vw} x ${vh} window (${Math.round(r.top)}-${Math.round(r.bottom)})`;
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top && (el === top || el.contains(top) || top.contains(el)) ? null : `${name}: covered by ${top?.tagName}.${String(top?.className).slice(0, 50)}`;
    };
    const lines = (el: Element) => {
      const style = getComputedStyle(el);
      const room = el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      return Math.round((room / parseFloat(getComputedStyle(el.querySelector("p") ?? el).lineHeight)) * 10) / 10;
    };
    const visible = (el: Element) => el.getBoundingClientRect().height > 0;
    const buttons = [...document.querySelectorAll("button")];
    const pane = document.querySelector('section[aria-label="Ljudet"]')!;
    const notices = [...document.querySelectorAll('[role="alert"]')].filter(visible);
    const log = document.querySelector('[role="log"]');
    const timer = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && visible(e) && /^\d+:\d\d$/.test(e.textContent?.trim() ?? ""));
    // A label that does not fit is cut with an ellipsis: the button is there and its word is not.
    const cut = (name: string, el: Element | undefined) =>
      el && [...el.querySelectorAll("*")].some((c) => c.scrollWidth > c.clientWidth && getComputedStyle(c).textOverflow === "ellipsis") ? `${name}: its label is cut` : null;
    const pausa = buttons.find((b) => /^(Pausa|Fortsätt)$/.test(b.textContent?.trim() ?? ""));
    const stoppa = buttons.find((b) => b.textContent?.trim() === "Stoppa");
    const controls = () => [
      problem("the recording dot", [...document.querySelectorAll('[class*="dot"]')].find(visible)),
      problem("the timer", timer),
      problem("Pausa", pausa),
      problem("Stoppa", stoppa),
      cut("Pausa", pausa),
      cut("Stoppa", stoppa),
    ];
    // The pane as it opens, then at each end of its scroll: the controls stand where they are throughout, the first
    // notice is whole at the start of it and the last one at the end, so what is long is reached by scrolling.
    const opened = pane.scrollTop;
    pane.scrollTop = 0;
    const atStart = [...controls(), problem("the first notice", notices[0])];
    pane.scrollTop = pane.scrollHeight;
    const atEnd = [...controls(), problem("the last notice", notices.at(-1))];
    pane.scrollTop = opened;
    return {
      problems: [...new Set([...atStart, ...atEnd].filter((p) => p && !(notices.length === 0 && /notice/.test(p))))],
      scrolls: pane.scrollHeight - pane.clientHeight > 1,
      notices: notices.length,
      logHeight: log ? Math.round(log.getBoundingClientRect().height) : null,
      // The room the text has, in its own lines: what the log's box holds inside its padding, over a line of the text.
      lines: log ? lines(log) : null,
    };
  });

const silent = (page: Page) =>
  page.addInitScript(() => {
    // A muted input: the stream carries digital silence, and the bar warns of it.
    navigator.mediaDevices.getUserMedia = async () => new AudioContext().createMediaStreamDestination().stream;
  });

const lowOnSpace = (page: Page) =>
  page.addInitScript(() => {
    // 1 MB left of 50: the bar warns that the device has little room, beside the silence.
    navigator.storage.estimate = async () => ({ quota: 50e6, usage: 49e6 });
  });

/** The page in DejaVu's width on any platform. */
const inDejaVuWidth = (page: Page) =>
  page.addInitScript(({ reference, width }) => {
    document.addEventListener("DOMContentLoaded", () => {
      const probe = Object.assign(document.createElement("span"), { textContent: reference });
      probe.style.cssText = `position: absolute; visibility: hidden; white-space: nowrap; font: 16px ${getComputedStyle(document.body).fontFamily}`;
      document.body.append(probe);
      const own = probe.getBoundingClientRect().width;
      probe.remove();
      const spacing = Math.max(0, (width - own) / reference.length / 16);
      document.head.append(Object.assign(document.createElement("style"), { textContent: `* { letter-spacing: ${spacing}em !important; }` }));
    });
  }, DEJAVU);

for (const { width, height } of SIZES) {
  for (const [mode, how] of [
    ["Spela in", "as it is"],
    ["Spela in", "with a warning"],
    ["Spela in", "with two warnings"],
    ["Strömma", "as it is"],
    ["Strömma", "with a warning"],
    ["Strömma", "with two warnings"],
    ["Strömma", "with a long text"],
  ] as const) {
    test(`${mode} ${how} at ${width} x ${height}: the recording is seen and its controls are in reach`, async ({ page }) => {
      await inDejaVuWidth(page);
      if (how.includes("warning")) await silent(page);
      if (how === "with two warnings") await lowOnSpace(page);
      if (how === "with a long text") await longLiveText(page);
      await page.setViewportSize({ width, height });
      await setup(page);
      await record(page, mode);
      if (how.includes("warning")) await expect(page.getByText("Vi hör inget från mikrofonen.")).toBeVisible({ timeout: 15_000 });
      if (how === "with two warnings") await expect(page.getByText("Det finns lite lagringsutrymme kvar på enheten.")).toBeVisible();
      if (how === "with a long text") await expect(page.getByRole("log", { name: "Preliminär text" })).toContainText("oktober", { timeout: 30_000 });
      await page.waitForTimeout(how === "with a long text" ? 3_000 : 800);

      const now = await seen(page);
      const said = JSON.stringify(now);
      expect(now.problems, `what a person must see (${said})`).toEqual([]);
      // Nothing to scroll past for what fits: no warning, or one.
      if (how !== "with two warnings") expect(now.scrolls, `nothing to scroll past (${said})`).toBe(false);
      // Two lines of text to read, whatever the font. A warning takes the text's room first (the person reads the warning,
      // and the text comes back with it gone), but a line of it stays; with two, the notices have the room.
      if (mode === "Strömma" && how !== "with two warnings") expect(now.lines, `${how === "with a warning" ? "a line" : "two lines"} of text to read (${said})`).toBeGreaterThanOrEqual(how === "with a warning" ? 1 : 2);
    });
  }
}
