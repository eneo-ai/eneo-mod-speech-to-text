/**
 * The result's playhead against the audio's own clock, as a person hears it: the word lit, the time and the slider while
 * a minute's meeting of two speakers plays; how long a press takes to play, from a WAV and from a recording as the app
 * records it (WebM without Cues); whether a highlight fades in behind the audio; and whether the word being said stays
 * in view. `currentTime` stands in for what is heard: the gate's Chromium plays muted, so a device's own output latency
 * is not in it.
 */
import { type Page, type TestInfo } from "@playwright/test";
import { expect, test } from "./gate";
import { isLaptop, run } from "./screens";
import ids from "../fixtures/ids.json";

// Timing tests: one at a time in their worker, so two of them do not measure each other.
test.describe.configure({ mode: "default" });

const PROJECTS = ["phone-390-light", "laptop-1440-light"];

/** A meeting of two speakers, as a streamed run gives one: sentences timed word by word, a pause between them. */
const TURNS: [string, string[]][] = [
  ["SPEAKER_00", ["Välkomna allihop till dagens möte om budgeten för nästa år.", "Vi har tre punkter och en timme på oss."]],
  ["SPEAKER_01", ["Tack, jag börjar med en kort bild av läget.", "Intäkterna ökar något men kostnaderna ökar mer än vi trodde."]],
  ["SPEAKER_00", [
    "Det betyder att vi måste prioritera redan i vår.",
    "Skolan och omsorgen ska inte drabbas av några nya besparingar.",
    "Kulturen och fritiden får däremot räkna med en mindre ram.",
    "Förvaltningen tar fram ett förslag till nästa sammanträde.",
    "Jag vill att alla partier får säga sitt innan dess.",
  ]],
  ["SPEAKER_01", ["Det låter rimligt för vår del.", "Vi vill också se vad investeringarna kostar över tid."]],
  ["SPEAKER_00", ["Då tar vi med det i förslaget."]],
  ["SPEAKER_01", ["Bra, då går vi vidare till nästa punkt.", "Den gäller skolskjutsarna efter höstlovet."]],
];
const WORD_S = 0.4;
const PAUSE_S = 0.4;
const MEETING_S = 60;

/** The sentences of `turns`, each word timed. */
function meetingOf(turns: [string, string[]][]) {
  let at = 0.2;
  return turns.flatMap(([speaker, sentences]) =>
    sentences.map((text) => {
      const parts = text.split(" ");
      const start = at;
      const words = parts.map((word, i) => ({ word, start: +(start + i * WORD_S).toFixed(3), end: +(start + (i + 1) * WORD_S).toFixed(3) }));
      at = start + parts.length * WORD_S + PAUSE_S;
      return { file_index: 0, start: +start.toFixed(3), end: words.at(-1)!.end, speaker, text, words };
    }),
  );
}

/** `seconds` of a quiet tone as 16-bit mono WAV. */
function wav(seconds: number, rate = 8_000) {
  const samples = Math.round(seconds * rate);
  const out = Buffer.alloc(44 + samples * 2);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + samples * 2, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) out.writeInt16LE(Math.round(1_500 * Math.sin((2 * Math.PI * 330 * i) / rate)), 44 + i * 2);
  return out;
}

/** The most bytes an answer to a Range carries, so the browser reads a file in slices, each a request of its own. */
const SLICE = 64 * 1024;

/**
 * The long run's page with `turns` as its transcript and `audio` as its recording, served as the module's proxy serves
 * it (no-store, Range answered with 206) in slices, each answered `latencyMs` late (the proxy's way to Eneo). Returns
 * the requests made for the audio, by their Range; the page has stopped making them.
 */
async function meeting(page: Page, info: TestInfo, audio: { bytes: Buffer; type: string }, turns = TURNS, latencyMs = 0) {
  const requests: string[] = [];
  const said = meetingOf(turns);
  await page.route(`**/runs/${ids.runs.long}/steps/`, async (route) => {
    const [transcribe, ...rest] = await (await route.fetch()).json();
    const payload = transcribe.input_payload_json;
    const transcription = { ...payload.transcription, segments: said, segments_hash: "meeting" };
    await route.fulfill({ json: [{ ...transcribe, input_payload_json: { ...payload, transcription } }, ...rest] });
  });
  // The words' times come from their own read, by sentence.
  await page.route(`**/runs/${ids.runs.long}/steps/*/transcript-words/`, async (route) => {
    const words = await (await route.fetch()).json();
    const segments = said.map((segment, segment_index) => ({ segment_index, words: segment.words.map((w) => ({ ...w, probability: null })) }));
    await route.fulfill({ json: { ...words, segments_hash: "meeting", segments } });
  });
  await page.route(new RegExp(`/input-files/${ids.files.audioA}/audio`), async (route) => {
    const range = route.request().headers()["range"] ?? "";
    requests.push(range);
    if (latencyMs) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    const headers = { "Content-Type": audio.type, "Accept-Ranges": "bytes", "Cache-Control": "private, no-store" };
    const asked = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!asked) return route.fulfill({ status: 200, headers, body: audio.bytes });
    const start = Number(asked[1]);
    const end = Math.min(asked[2] ? Number(asked[2]) : Infinity, start + SLICE - 1, audio.bytes.length - 1);
    await route.fulfill({
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${audio.bytes.length}` },
      body: audio.bytes.subarray(start, end + 1),
    });
  });
  await run(page, ids.runs.long);
  await expect(page.getByRole("heading", { name: "Dokumentet är klart" })).toBeVisible();
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  await expect(page.locator("[data-turn-index]")).toHaveCount(turns.length);
  // As a person finds the page: its audio's length read, and the browser done reading ahead.
  await expect.poll(() => page.locator("audio").evaluate((a: HTMLAudioElement) => a.readyState)).toBeGreaterThanOrEqual(1);
  await expect
    .poll(async () => {
      const made = requests.length;
      await page.waitForTimeout(latencyMs + 500);
      return requests.length === made;
    })
    .toBe(true);
  return requests;
}

const play = (page: Page) => page.locator("[data-docked-player]").getByRole("button", { name: "Spela upp", exact: true });
const pause = (page: Page) => page.locator("[data-docked-player]").getByRole("button", { name: "Pausa uppspelningen" }).first().click();
const currentTime = (page: Page) => page.locator("audio").evaluate((a: HTMLAudioElement) => a.currentTime);

type Sample = {
  wall: number;
  t: number;
  lit: number | null;
  next: number | null;
  clock: string;
  slider: number;
  litInView: boolean | null;
  sentence: number;
};

/**
 * Every frame for `ms`: the audio's clock, the word lit and the next word's start, the player's time and slider, the
 * sentence the playhead is in, and whether the word lit is where it can be read (inside the box that scrolls and the
 * window, not under the docked player).
 */
function sample(page: Page, ms: number): Promise<Sample[]> {
  return page.evaluate(async (ms) => {
    const audio = document.querySelector("audio")!;
    // A page's own bar is docked too while it plays: the player is the dock with the slider.
    const slider = document.querySelector<HTMLElement>('[data-docked-player] [role="slider"]')!;
    const dock = slider.closest<HTMLElement>("[data-docked-player]")!;
    const clock = [...dock.querySelectorAll<HTMLElement>("*")].find(
      (e) => e.childElementCount === 0 && /^\d+:\d\d( \/ \d+:\d\d)?$/.test(e.textContent ?? ""),
    )!;
    const starts = [...new Set([...document.querySelectorAll<HTMLElement>("[data-word-start]")].map((w) => Number(w.dataset.wordStart)))].sort(
      (a, b) => a - b,
    );
    let scroller: HTMLElement | null = document.querySelector<HTMLElement>("[data-turn-index]")!.parentElement;
    while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) {
      scroller = scroller.parentElement;
    }
    const inView = (element: Element) => {
      const port = scroller?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight };
      let top = Math.max(port.top, 0);
      let bottom = Math.min(port.bottom, innerHeight);
      const docked = dock.getBoundingClientRect();
      if (docked.top < bottom && docked.bottom > top) {
        if (docked.top > (top + bottom) / 2) bottom = docked.top;
        else top = docked.bottom;
      }
      const box = element.getBoundingClientRect();
      return box.top >= top - 1 && box.bottom <= bottom + 1;
    };
    const out: Sample[] = [];
    const end = performance.now() + ms;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(function frame(wall) {
        const lit = document.querySelector<HTMLElement>('[data-word-start][aria-current="true"]');
        const litStart = lit ? Number(lit.dataset.wordStart) : null;
        const sentence = document.querySelector<HTMLElement>('[data-segment-index][data-active="true"]');
        out.push({
          wall,
          t: audio.currentTime,
          lit: litStart,
          next: litStart === null ? null : (starts.find((s) => s > litStart) ?? null),
          clock: clock.textContent ?? "",
          slider: Number(slider.getAttribute("aria-valuenow")),
          litInView: lit ? inView(lit) : null,
          sentence: sentence ? Number(sentence.dataset.segmentIndex) : -1,
        });
        if (wall < end) requestAnimationFrame(frame);
        else resolve();
      }),
    );
    return out;
  }, ms);
}

/** "1:05", or "1:05 / 2:00", as seconds: the position the player shows. */
const shownSeconds = (clock: string) => {
  const [m, s] = clock.split(" / ")[0].split(":").map(Number);
  return m * 60 + s;
};

const measure = (info: TestInfo, type: string, measured: unknown) => {
  info.annotations.push({ type, description: JSON.stringify(measured) });
  console.log(`[${type} ${info.project.name}]`, JSON.stringify(measured));
};

test("while a meeting plays, the word lit, the time and the slider keep to the audio's clock, every frame", async ({ page }, info) => {
  test.skip(!PROJECTS.includes(info.project.name));
  await meeting(page, info, { bytes: wav(MEETING_S), type: "audio/wav" });
  await play(page).click();
  await expect.poll(() => currentTime(page)).toBeGreaterThan(0.3);
  const samples = await sample(page, 6_000);
  await pause(page);

  const gaps = samples.slice(1).map((s, i) => s.wall - samples[i].wall);
  const lit = samples.filter((s) => s.lit !== null);
  const wordOff = lit.filter((s) => s.t < s.lit! - 0.1 || (s.next !== null && s.t > s.next + 0.15));
  // The time shows whole seconds: how long after a second has passed it still shows the one before.
  const clockLate = Math.max(...samples.map((s) => s.t - (shownSeconds(s.clock) + 1)));
  const clockEarly = Math.max(...samples.map((s) => shownSeconds(s.clock) - s.t));
  const sliderOff = Math.max(...samples.map((s) => Math.abs(s.slider - s.t)));
  const measured = {
    frames: samples.length,
    maxFrameGapMs: Math.round(Math.max(...gaps)),
    litFrames: lit.length,
    wordOffFrames: wordOff.length,
    clockLateMs: Math.round(clockLate * 1_000),
    clockEarlyMs: Math.round(clockEarly * 1_000),
    sliderOffMs: Math.round(sliderOff * 1_000),
  };
  measure(info, "sync", measured);

  expect(lit.length, "a word is lit while the meeting is spoken").toBeGreaterThan(samples.length / 2);
  expect(wordOff, "the word lit is the one the audio is at (from 0.1 s before it starts to 0.15 s after the next starts)").toEqual([]);
  expect(measured.maxFrameGapMs, "no frame is held up").toBeLessThan(120);
  // The slider moves in steps of a pixel of its track (at least 50 ms), drawn at the next frame.
  expect(measured.sliderOffMs, "the slider is where the audio is, within a step and a frame").toBeLessThanOrEqual(150);
  expect(measured.clockEarlyMs, "the time never runs ahead of the audio").toBeLessThanOrEqual(50);
  expect(measured.clockLateMs, "the time turns to the next second with the audio, within a frame or two").toBeLessThanOrEqual(100);
});

type Probe = { pressed: number; base: number; stepped: number; playing: number; waiting: number };

/**
 * From a press to the audio's first step on from where the press put it, and to its playing 0.1 s past `from` (0, or
 * the word pressed); the times it stopped for want of data, and the requests for the audio made in between.
 */
async function pressToPlaying(page: Page, requests: string[], from: number, press: () => Promise<unknown>) {
  await page.evaluate((from) => {
    const audio = document.querySelector("audio")!;
    const probe: Probe = { pressed: 0, base: -1, stepped: 0, playing: 0, waiting: 0 };
    (window as unknown as { probe: Probe }).probe = probe;
    audio.addEventListener("waiting", () => probe.waiting++);
    document.addEventListener("click", () => (probe.pressed ||= performance.now()), { capture: true });
    requestAnimationFrame(function frame() {
      const now = performance.now();
      // Where the press put it (a word's start once it has been sought), then its first step on from there.
      if (probe.pressed && probe.base < 0) probe.base = audio.currentTime;
      else if (probe.pressed && !probe.stepped && audio.currentTime > probe.base) probe.stepped = now;
      if (probe.pressed && audio.currentTime >= from + 0.1) probe.playing = now;
      else requestAnimationFrame(frame);
    });
  }, from);
  const before = requests.length;
  await press();
  await page.waitForFunction(() => (window as unknown as { probe: Probe }).probe.playing > 0);
  const probe = await page.evaluate(() => (window as unknown as { probe: Probe }).probe);
  const made = requests.length - before;
  await pause(page);
  return {
    firstStepMs: Math.round((probe.stepped || probe.playing) - probe.pressed),
    playingMs: Math.round(probe.playing - probe.pressed),
    waiting: probe.waiting,
    requests: made,
  };
}

/** The fake microphone's tone recorded as the app records it (WebM, Opus, 32 kbit/s), its length written in: no Cues. */
async function recording(page: Page, seconds: number) {
  await page.goto("/");
  const recorded = await page.evaluate(async (ms) => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // The app's own settings (SPEECH_RECORDING in lib/recording-session.ts).
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 32_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
    recorder.start(1_000);
    await new Promise((resolve) => setTimeout(resolve, ms));
    await new Promise((resolve) => ((recorder.onstop = resolve), recorder.stop()));
    stream.getTracks().forEach((track) => track.stop());
    return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
  }, seconds * 1_000);
  const { withWebmDuration } = await import("../../lib/webm-duration");
  const bytes = new Uint8Array(recorded);
  const head = withWebmDuration(bytes.subarray(0, 16 * 1024), seconds * 1_000);
  expect(head, "the recording's length written in, as the app does before it sends it").not.toBeNull();
  return Buffer.concat([head!, bytes.subarray(16 * 1024)]);
}

test("a press plays at once, from a WAV and from a recording as the app makes it, also from a word far in", async ({ page }, info) => {
  test.skip(info.project.name !== "laptop-1440-light", "the browser's own loading: one Chromium");
  test.setTimeout(150_000);
  // Each answer for the audio 300 ms late: a press that had to wait for one would take longer than that to play.
  const latency = 300;
  const webm = await recording(page, 12);
  const measured: Record<string, Awaited<ReturnType<typeof pressToPlaying>>> = {};
  for (const [name, audio] of [["wav", { bytes: wav(MEETING_S), type: "audio/wav" }], ["webm", { bytes: webm, type: "audio/webm" }]] as const) {
    // Each from a page just opened, as a person comes to it: nothing played yet.
    const fromStart = await meeting(page, info, audio, TURNS, latency);
    measured[`${name} from start`] = await pressToPlaying(page, fromStart, 0, () => play(page).click());
    await page.unrouteAll({ behavior: "ignoreErrors" });
    const fromWord = await meeting(page, info, audio, TURNS, latency);
    measured[`${name} from 7.8 s`] = await pressToPlaying(page, fromWord, 7.8, () => page.locator('[data-word-start="7.8"]').click());
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
  measure(info, "start", measured);
  for (const [name, { firstStepMs, playingMs }] of Object.entries(measured)) {
    expect(firstStepMs, `${name}: the audio moves on without waiting for the network`).toBeLessThan(latency);
    expect(playingMs, `${name}: and has played 0.1 s soon after`).toBeLessThan(latency + 100);
  }
});

type Lit = { kind: string; at: number; fadeMs: number };

// Measures the fade the playhead's tints start with (recorded, not held to a bound); a word under the pointer fades.
test("the fade a word, sentence and passage the playhead reaches start with, and a word under the pointer fades", async ({ page }, info) => {
  test.skip(!PROJECTS.includes(info.project.name));
  await meeting(page, info, { bytes: wav(MEETING_S), type: "audio/wav" });
  // Every word, sentence and passage lit while it plays, and the fade its tint starts with (a transition of its background).
  await page.evaluate(() => {
    const lit: Lit[] = [];
    (window as unknown as { lit: Lit[] }).lit = lit;
    new MutationObserver((records) => {
      for (const { target, attributeName } of records) {
        const element = target as HTMLElement;
        if (!element.hasAttribute(attributeName!)) continue;
        const kind = element.hasAttribute("data-turn-index") ? "turn" : element.hasAttribute("data-segment-index") ? "sentence" : "word";
        const fades = element.getAnimations().filter((a) => (a as CSSTransition).transitionProperty === "background-color");
        lit.push({ kind, at: performance.now(), fadeMs: Math.max(0, ...fades.map((a) => Number(a.effect!.getTiming().duration))) });
      }
    }).observe(document.querySelector("[data-turn-index]")!.parentElement!, { subtree: true, attributeFilter: ["data-lit", "data-active"] });
  });
  // From the last word of the second sentence, through the pause, into the other speaker's passage.
  await page.locator('[data-word-start="7.8"]').click();
  const clicked = await page.evaluate(() => performance.now());
  await expect.poll(() => currentTime(page)).toBeGreaterThan(9.2);
  await pause(page);
  const lit = (await page.evaluate(() => (window as unknown as { lit: Lit[] }).lit)).filter((l) => l.at > clicked + 100);
  const fades = Object.fromEntries(["word", "sentence", "turn"].map((kind) => [kind, Math.max(...lit.filter((l) => l.kind === kind).map((l) => l.fadeMs))]));
  measure(info, "highlight", { fades, durationFast: await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--duration-fast")) });

  expect(Object.values(fades).every(Number.isFinite), "a word, a sentence and a passage were lit").toBe(true);
  // A word keeps its short fade under the pointer.
  const later = page.locator('[data-turn-index="5"] [data-word-start]').first();
  expect(await later.evaluate((word) => getComputedStyle(word).transitionDuration)).not.toBe("0s");
});

test("following a meeting as it plays, the word being said stays in view from passage to passage", async ({ page }, info) => {
  test.skip(!PROJECTS.includes(info.project.name));
  // Three minutes of it, longer than the window, played at twice the speed.
  await meeting(page, info, { bytes: wav(3 * MEETING_S), type: "audio/wav" }, [...TURNS, ...TURNS, ...TURNS]);
  await page.getByRole("button", { name: "Hastighet 1×" }).click();
  await page.getByRole("menuitemradio", { name: "2×" }).click();
  await play(page).click();
  // From where the press brought the first word into view.
  const all = await sample(page, 20_000);
  const samples = all.slice(all.findIndex((s) => s.litInView));
  await pause(page);

  // Each sentence as it starts: how long until the word lit in it is in view.
  const late = samples.flatMap((s, i) => {
    if (s.sentence < 0 || s.sentence === samples[i - 1]?.sentence) return [];
    const seen = samples.slice(i).find((later) => later.litInView);
    return [{ sentence: s.sentence, ms: Math.round((seen?.wall ?? Infinity) - s.wall) }];
  });
  let out = 0;
  let longestOut = 0;
  samples.forEach((s, i) => {
    out = s.litInView === false ? out + (i > 0 ? s.wall - samples[i - 1].wall : 0) : 0;
    longestOut = Math.max(longestOut, out);
  });
  measure(info, "follow", { late, longestOutMs: Math.round(longestOut) });
  expect(late.length, "several sentences start, of several passages").toBeGreaterThan(6);
  expect(longestOut, "the word being said is never out of view for longer than a frame or two").toBeLessThanOrEqual(50);
});

test("in a passage taller than the window, the sentence being said stays in view as it plays", async ({ page }, info) => {
  test.skip(!PROJECTS.includes(info.project.name));
  // A presentation of some three minutes by one speaker between two short turns: one passage, taller than the window.
  const presentation = Array.from({ length: 8 }, () => TURNS[2][1]).flat();
  await meeting(page, info, { bytes: wav(4 * MEETING_S), type: "audio/wav" }, [TURNS[0], TURNS[1], ["SPEAKER_00", presentation], TURNS[3]]);
  // Its last sentence, pressed where it is read, and played on.
  const last = page.locator('[data-turn-index="2"] [data-segment-index]').last().locator("[data-word-start]").first();
  await last.scrollIntoViewIfNeeded();
  await last.click();
  const samples = await sample(page, 3_000);
  await pause(page);
  const out = samples.filter((s) => s.litInView === false);
  measure(info, "tall", { outFrames: out.length, frames: samples.length });
  expect(out.length, "the word being said is in view").toBe(0);
});
