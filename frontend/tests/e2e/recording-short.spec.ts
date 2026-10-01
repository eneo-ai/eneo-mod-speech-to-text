/**
 * A short screen (a phone on its side, 200 % zoom) is wide and has little height to give the recording: the person must
 * still see that recording is on (the dot and the timer), reach Pausa and Stoppa without scrolling past anything, and
 * with Strömma keep a text to read, however long it grows and whatever the bar says above its buttons.
 */
import { expect, test, type Page } from "@playwright/test";
import { longLiveText } from "./live-relay";
import { record, setup } from "./screens";

test.beforeEach(({}, info) => test.skip(info.project.name !== "phone-390-light", "the window is set below"));

const SIZES = [
  { width: 844, height: 390 },
  { width: 640, height: 400 },
  { width: 568, height: 320 },
] as const;

/** What of the recording a person must see, each as null when it is wholly in the window and not covered. */
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
    const buttons = [...document.querySelectorAll("button")];
    const timer = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && /^\d+:\d\d$/.test(e.textContent?.trim() ?? ""));
    const log = document.querySelector('[role="log"]');
    return {
      problems: [
        problem("the recording dot", document.querySelector('[class*="dot"]')),
        problem("the timer", timer),
        problem("Pausa", buttons.find((b) => /^(Pausa|Fortsätt)$/.test(b.textContent?.trim() ?? ""))),
        problem("Stoppa", buttons.find((b) => b.textContent?.trim() === "Stoppa")),
      ].filter(Boolean),
      logHeight: log ? Math.round(log.getBoundingClientRect().height) : null,
      stopTop: Math.round(buttons.find((b) => b.textContent?.trim() === "Stoppa")?.getBoundingClientRect().top ?? -1),
    };
  });

const silent = (page: Page) =>
  page.addInitScript(() => {
    // A muted input: the stream carries digital silence, and the bar warns of it.
    navigator.mediaDevices.getUserMedia = async () => new AudioContext().createMediaStreamDestination().stream;
  });

for (const { width, height } of SIZES) {
  for (const [mode, how] of [
    ["Spela in", "as it is"],
    ["Spela in", "with a warning"],
    ["Strömma", "as it is"],
    ["Strömma", "with a warning"],
    ["Strömma", "with a long text"],
  ] as const) {
    test(`${mode} ${how} at ${width} x ${height}: the recording is seen and its controls are in reach`, async ({ page }) => {
      if (how === "with a warning") await silent(page);
      if (how === "with a long text") await longLiveText(page);
      await page.setViewportSize({ width, height });
      await setup(page);
      await record(page, mode);
      if (how === "with a warning") await expect(page.getByText("Vi hör inget från mikrofonen.")).toBeVisible({ timeout: 15_000 });
      if (how === "with a long text") await expect(page.getByRole("log", { name: "Preliminär text" })).toContainText("oktober", { timeout: 30_000 });
      await page.waitForTimeout(how === "with a long text" ? 3_000 : 800);

      const now = await seen(page);
      expect(now.problems, `what a person must see (${JSON.stringify(now)})`).toEqual([]);
      // A warning takes the room of the text first: the person reads the warning, and the text comes back with it gone.
      if (mode === "Strömma") expect(now.logHeight, "a text to read").toBeGreaterThanOrEqual(how === "with a warning" ? 24 : 60);
    });
  }
}
