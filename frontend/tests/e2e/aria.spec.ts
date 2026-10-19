/**
 * What a screen reader is given: ARIA snapshots of the key regions (names,
 * roles, states, live regions), reviewed and kept in aria.spec.ts-snapshots,
 * and the text that reaches the live regions during a recording: each status
 * change once, never the ticking timer. These are DOM text changes; what a
 * screen reader actually says is on the manual list. The snapshots are of the page's markup as Playwright reads it,
 * the same in every engine unless the page itself differs there. Where it does, the engine has a file of its own for
 * that state, `<state>-<width>-<engine>.aria.yml`, a copy that differs in that one thing: the setup names the default
 * microphone in Chromium, whose fake devices have names, and asks there which of them to pick; WebKit and Firefox name
 * none before a test, so they have nothing to choose from. Where there is no such file the engines share the one.
 *
 * The files are curated by hand: a pattern where a value varies, no generated id, only the nodes that say something.
 * Playwright's own update would write its raw tree over that, so this spec never lets it write. Run with
 * `--update-snapshots`, or for a state that has no file yet, a test puts the page's raw tree in its results folder and
 * fails with the two paths: carry what changed over to the curated file by hand, or copy and curate a new one.
 */
import { existsSync, writeFileSync } from "node:fs";
import { type Page } from "@playwright/test";
import { expect, test } from "./gate";
import { needsRecording, STATES } from "./screens";

// Dates the page shows are read against this time, so the snapshots stay put.
const NOW = new Date("2026-09-24T12:00:00+02:00");

/**
 * `waysIn`: the region shows the setup's ways in. Where the browser cannot record (`records` in screens.ts) the setup is
 * another page, the upload alone, so these snapshots are not taken there.
 */
const SNAPSHOTS: { state: string; region: (page: Page) => ReturnType<Page["locator"]>; fixedTime?: boolean; waysIn?: true }[] = [
  { state: "flow-list", region: (page) => page.locator("[data-app-shell]"), fixedTime: true },
  { state: "version", region: (page) => page.getByRole("main") },
  { state: "version-nothing-known", region: (page) => page.getByRole("main") },
  { state: "unsent-recordings", region: (page) => page.getByRole("region", { name: /inte skickats/ }) },
  { state: "setup", region: (page) => page.locator("[data-app-shell]"), fixedTime: true, waysIn: true },
  { state: "setup-participants", region: (page) => page.getByRole("main"), fixedTime: true, waysIn: true },
  { state: "setup-required-detail", region: (page) => page.getByRole("main"), waysIn: true },
  { state: "setup-date", region: (page) => page.getByRole("main"), fixedTime: true, waysIn: true },
  { state: "recording", region: (page) => page.locator("[data-app-shell]") },
  { state: "stromma", region: (page) => page.getByRole("region", { name: "Ljudet" }) },
  { state: "leave-dialog", region: (page) => page.getByRole("alertdialog") },
  { state: "ready", region: (page) => page.getByRole("region", { name: "Ljudet" }) },
  { state: "run-progress", region: (page) => page.getByRole("main") },
  { state: "result", region: (page) => page.getByRole("main"), fixedTime: true },
  { state: "result-transcript-tab", region: (page) => page.getByRole("main"), fixedTime: true },
  { state: "result-table", region: (page) => page.getByRole("main"), fixedTime: true },
  { state: "result-regenerate", region: (page) => page.getByRole("main"), fixedTime: true },
  { state: "failure", region: (page) => page.getByRole("main"), fixedTime: true },
  { state: "review", region: (page) => page.getByRole("main"), fixedTime: true },
  { state: "naming-dialog", region: (page) => page.getByRole("dialog") },
  { state: "result-naming-dialog", region: (page) => page.getByRole("dialog") },
  { state: "signed-out-recording", region: (page) => page.getByRole("alertdialog") },
  { state: "review-din-version", region: (page) => page.getByRole("main") },
  { state: "flow-republish-required", region: (page) => page.locator("[data-app-shell]") },
  { state: "flows-unreachable", region: (page) => page.locator("[data-app-shell]") },
];

for (const { state, region, fixedTime, waysIn } of SNAPSHOTS) {
  test(`aria ${state}`, async ({ page, browserName }, info) => {
    const screen = STATES.find((s) => s.name === state)!;
    test.skip(screen.only ? !screen.only(info) : false, "the state does not exist at this width or in this browser");
    if (waysIn) needsRecording();
    if (fixedTime) await page.clock.setFixedTime(NOW);
    await screen.go(page, info);
    const width = info.project.use.viewport!.width;
    const own = `${state}-${width}-${browserName}.aria.yml`;
    const name = existsSync(info.snapshotPath(own, { kind: "aria" })) ? own : `${state}-${width}.aria.yml`;
    const curated = info.snapshotPath(name, { kind: "aria" });
    const updating = info.config.updateSnapshots === "all" || info.config.updateSnapshots === "changed";
    if (updating || !existsSync(curated)) {
      const raw = info.outputPath(name);
      writeFileSync(raw, await region(page).ariaSnapshot());
      throw new Error(
        updating
          ? `${name} is curated by hand, so --update-snapshots does not write it. The page's raw tree is in ${raw}: carry what changed over to ${curated}, then run without the flag.`
          : `There is no snapshot of ${state} at ${width} px. The page's raw tree is in ${raw}: copy it to ${curated}, curate it (a pattern where a value varies, no generated id), and run again.`,
      );
    }
    await expect(region(page)).toMatchAriaSnapshot({ name });
  });
}

/** Records each change of a live region's text (aria-hidden parts left out), in order. */
function listen() {
  const said: { region: string; text: string }[] = [];
  const last = new WeakMap<Element, string>();
  const spoken = (node: Node): string =>
    node.nodeType === Node.TEXT_NODE
      ? (node.textContent ?? "")
      : node instanceof Element && node.getAttribute("aria-hidden") !== "true"
        ? Array.from(node.childNodes).map(spoken).join("")
        : "";
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      // An alert is said when it is added, too, not only when its text changes.
      const alerts = Array.from(mutation.addedNodes).flatMap((node) =>
        node instanceof Element ? [node, ...Array.from(node.querySelectorAll('[role="alert"]'))].filter((el) => el.matches('[role="alert"]')) : [],
      );
      const changed = target?.closest('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"], [role="timer"]');
      for (const live of changed ? [changed, ...alerts] : alerts) {
        // The route's announcement is RouteEffects' own and has its own test (route-change.spec.ts).
        if (live.hasAttribute("data-astryx-live-region")) continue;
        const text = spoken(live).replace(/\s+/g, " ").trim();
        if (!text || last.get(live) === text) continue;
        last.set(live, text);
        said.push({ region: `${live.getAttribute("role") ?? "live"} ${live.getAttribute("aria-label") ?? ""}`.trim(), text });
      }
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
  (window as unknown as { said: typeof said }).said = said;
}

const heard = (page: Page) => page.evaluate(() => (window as unknown as { said: { region: string; text: string }[] }).said);
const CLOCK = /\b\d{1,2}:\d{2}\b/;

test("recording states reach a live region's text once, and the timer never does", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390-light", "one width is enough");
  await page.addInitScript(listen);
  await STATES.find((s) => s.name === "setup")!.go(page, info);
  await page.getByRole("radio", { name: /^Spela in/ }).click();
  await page.getByRole("button", { name: "Starta inspelning" }).click();
  await page.waitForTimeout(3_500);
  await page.getByRole("button", { name: "Pausa" }).click();
  await page.waitForTimeout(1_500);
  await page.getByRole("button", { name: "Fortsätt" }).click();
  await page.waitForTimeout(2_500);
  const said = await heard(page);
  const times = (text: string) => said.filter((s) => s.text === text).length;
  expect(said.filter((s) => CLOCK.test(s.text)), "no live region reads out a time").toEqual([]);
  expect(times("Spelar in."), "recording is said at the start and after the pause").toBe(2);
  expect(times("Inspelningen är pausad."), "the pause is said once").toBe(1);
});

test("live text reaches the log in committed pieces, and the timer never does", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390-light", "one width is enough");
  await page.addInitScript(listen);
  await STATES.find((s) => s.name === "stromma")!.go(page, info);
  await page.waitForTimeout(3_000);
  const said = await heard(page);
  const log = said.filter((s) => s.region === "log Preliminär text");
  expect(said.filter((s) => CLOCK.test(s.text)), "no live region reads out a time").toEqual([]);
  expect(log.length, "the draft reaches the log").toBeGreaterThan(0);
  // A committed piece is read once: each log reading only adds to the one before.
  expect(log.every((s, i) => i === 0 || s.text.startsWith(log[i - 1].text)), "the log only grows").toBe(true);
});

test("a lost microphone reaches a live region's text once", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390-light", "one width is enough");
  await page.addInitScript(listen);
  // Keep each microphone stream, so the test can end its track as a lost microphone would.
  await page.addInitScript(() => {
    const streams: MediaStream[] = [];
    (window as unknown as { streams: MediaStream[] }).streams = streams;
    const media = navigator.mediaDevices;
    const original = media.getUserMedia.bind(media);
    media.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      streams.push(stream);
      return stream;
    };
  });
  await STATES.find((s) => s.name === "recording")!.go(page, info);
  await page.evaluate(() => {
    const { streams } = window as unknown as { streams: MediaStream[] };
    streams.at(-1)!.getAudioTracks()[0].dispatchEvent(new Event("ended"));
  });
  await expect(page.getByRole("button", { name: "Fortsätt" })).toBeVisible();
  await page.waitForTimeout(500);
  const said = (await heard(page)).filter((s) => s.text.includes("mikrofonen försvann"));
  expect(said, "the sentence reaches a live region exactly once").toHaveLength(1);
});
