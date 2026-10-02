/**
 * A short screen (a phone on its side, 200 % zoom) is wide and has little height to give the recording: the person must
 * still see that recording is on (the dot and the timer), reach Pausa and Stoppa without scrolling past anything, read
 * what warns of a lost meeting, and with Strömma keep a text to read, however long it grows. Two kinds of guarantee, set
 * apart: the controls stand whole in the window whatever the text does (also with the words set far wider than any font
 * sets them), and the text keeps its lines in the platform's own font (CI's DejaVu Sans is the widest sans there is).
 */
import { expect, test, type Page } from "@playwright/test";
import { longLiveText } from "./live-relay";
import { record, setup } from "./screens";

test.beforeEach(({}, info) => test.skip(info.project.name !== "phone-390-light", "the window is set below"));

/** Every word set a sixth wider than DejaVu Sans, the widest sans there is, sets it: what holds with this holds whatever the text does. */
const FAR_WIDER = "* { letter-spacing: 0.1em !important; }";

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
      cut: [cut("Pausa", pausa), cut("Stoppa", stoppa)].filter(Boolean),
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

const wider = (page: Page) =>
  page.addInitScript((css) => {
    document.addEventListener("DOMContentLoaded", () => document.head.append(Object.assign(document.createElement("style"), { textContent: css })));
  }, FAR_WIDER);

const STATES = [
  ["Spela in", "as it is"],
  ["Spela in", "with a warning"],
  ["Spela in", "with two warnings"],
  ["Strömma", "as it is"],
  ["Strömma", "with a warning"],
  ["Strömma", "with two warnings"],
  ["Strömma", "with a long text"],
] as const;

/** Opens the recording at a size, in a state, and reports what of it is seen. */
async function recording(page: Page, mode: "Spela in" | "Strömma", how: (typeof STATES)[number][1], { width, height }: { width: number; height: number }) {
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
  return seen(page);
}

// In the platform's own font: what the person sees, and the text's room in lines.
for (const size of SIZES) {
  for (const [mode, how] of STATES) {
    test(`${mode} ${how} at ${size.width} x ${size.height}: the recording is seen and its controls are in reach`, async ({ page }) => {
      const now = await recording(page, mode, how, size);
      const said = JSON.stringify(now);
      expect(now.problems, `what a person must see (${said})`).toEqual([]);
      expect(now.cut, `a button's word is whole (${said})`).toEqual([]);
      // Nothing to scroll past for what fits: no warning, or one.
      if (how !== "with two warnings") expect(now.scrolls, `nothing to scroll past (${said})`).toBe(false);
      // Two lines of text to read. A warning takes the text's room first (the person reads the warning, and the text comes
      // back with it gone), but a line of it stays; with two, the notices have the room.
      if (mode === "Strömma" && how !== "with two warnings") expect(now.lines, `${how === "with a warning" ? "a line" : "two lines"} of text to read (${said})`).toBeGreaterThanOrEqual(how === "with a warning" ? 1 : 2);
    });
  }
}

// With the words set far wider than a font does: no text room is promised, the controls and the first and last notice are.
for (const [mode, how] of STATES) {
  test(`${mode} ${how} at 568 x 320 with the words set far wider: the controls are in reach whatever the text does`, async ({ page }) => {
    await wider(page);
    const now = await recording(page, mode, how, SIZES[2]);
    expect(now.problems, `what a person must see (${JSON.stringify(now)})`).toEqual([]);
  });
}
