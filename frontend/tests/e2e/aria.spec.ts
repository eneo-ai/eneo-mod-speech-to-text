/**
 * What a screen reader is given: ARIA snapshots of the key regions (names,
 * roles, states, live regions), reviewed and kept in aria.spec.ts-snapshots,
 * and the text that reaches the live regions during a recording: each status
 * change once, never the ticking timer. These are DOM text changes; what a
 * screen reader actually says is on the manual list.
 */
import { expect, test, type Page } from "@playwright/test";
import { STATES } from "./screens";

// Dates the page shows are read against this time, so the snapshots stay put.
const NOW = new Date("2026-09-24T12:00:00+02:00");

const SNAPSHOTS: { state: string; region: (page: Page) => ReturnType<Page["locator"]>; fixedTime?: boolean }[] = [
  { state: "signin-access-code", region: (page) => page.locator(".app-shell") },
  { state: "flow-list", region: (page) => page.locator(".app-shell"), fixedTime: true },
  { state: "unsent-recordings", region: (page) => page.getByRole("region", { name: /inte skickad/ }) },
  { state: "setup", region: (page) => page.locator(".app-shell"), fixedTime: true },
  { state: "setup-participants", region: (page) => page.getByRole("main"), fixedTime: true },
  { state: "setup-required-detail", region: (page) => page.getByRole("main") },
  { state: "recording", region: (page) => page.locator(".app-shell") },
  { state: "stromma", region: (page) => page.getByRole("region", { name: "Ljudet" }) },
  { state: "leave-dialog", region: (page) => page.getByRole("alertdialog") },
  { state: "ready", region: (page) => page.getByRole("region", { name: "Ljudet" }) },
  { state: "run-progress", region: (page) => page.getByRole("main") },
  { state: "result", region: (page) => page.getByRole("main"), fixedTime: true },
  { state: "result-transcript-tab", region: (page) => page.getByRole("main"), fixedTime: true },
  { state: "result-regenerate", region: (page) => page.getByRole("main"), fixedTime: true },
  { state: "failure", region: (page) => page.getByRole("main"), fixedTime: true },
  { state: "review", region: (page) => page.getByRole("main"), fixedTime: true },
  { state: "naming-dialog", region: (page) => page.getByRole("dialog") },
  { state: "signed-out-recording", region: (page) => page.getByRole("alertdialog") },
  { state: "review-din-version", region: (page) => page.getByRole("main") },
  { state: "flow-republish-required", region: (page) => page.locator(".app-shell") },
];

for (const { state, region, fixedTime } of SNAPSHOTS) {
  test(`aria ${state}`, async ({ page }, info) => {
    const screen = STATES.find((s) => s.name === state)!;
    test.skip(screen.only ? !screen.only(info) : false, "not on this width");
    if (fixedTime) await page.clock.setFixedTime(NOW);
    await screen.go(page, info);
    const width = info.project.use.viewport!.width;
    await expect(region(page)).toMatchAriaSnapshot({ name: `${state}-${width}.aria.yml` });
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
      const live = target?.closest('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"], [role="timer"]');
      if (!live || live.id === "__next-route-announcer__") continue;
      const text = spoken(live).replace(/\s+/g, " ").trim();
      if (!text || last.get(live) === text) continue;
      last.set(live, text);
      said.push({ region: `${live.getAttribute("role") ?? "live"} ${live.getAttribute("aria-label") ?? ""}`.trim(), text });
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
