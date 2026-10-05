import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import type { LiveSession } from "./flow-session";
import type { LiveSnapshot } from "./live-transcriber";
import { openRecordingStore } from "./recording-store";
import { cleanup, installDom, mount } from "./test-dom";

// The recording's surfaces (Recorder, LiveSheet) in a document, queried by role, name and attribute.
installDom();
afterEach(cleanup);

test("the bar keeps Pausa and Stoppa in place, says Fortsätt while paused, and the timer is never in a live region", async () => {
  const { createElement } = await import("react");
  const { FocusedRecorder, RecordingBar } = await import("../components/flow/Recorder");
  const { RecordingCapture } = await import("./recording-session");
  const capture = new RecordingCapture(() => openRecordingStore({}), {
    getStream: async () => {
      throw new Error("not used");
    },
    createRecorder: () => {
      throw new Error("not used");
    },
  });
  const bar = (phase: "recording" | "paused", showStatus: boolean, warnings = [] as { title: string; detail?: string }[]) =>
    mount(
      createElement(RecordingBar, {
        capture,
        phase,
        stream: null,
        showStatus,
        warnings,
        notes: ["Låt skärmen vara tänd under inspelningen."],
        onPause: () => {},
        onStop: () => {},
      }),
    );
  const words = (container: ParentNode) => [...container.querySelectorAll("button")].map((button) => button.textContent?.trim());
  const text = (container: ParentNode, selector: string, content: string) =>
    [...container.querySelectorAll<HTMLElement>(selector)].find((element) => element.textContent?.trim() === content);

  const running = await bar("recording", true);
  assert.deepEqual(words(running.container), ["Pausa", "Stoppa"]);
  // The word's own element: the status around it holds the dot too.
  const word = [...running.container.querySelectorAll("span")].find((element) => element.children.length === 0 && element.textContent === "Spelar in");
  assert.ok(word, "the status says it in words");
  assert.equal(word.previousElementSibling?.getAttribute("aria-hidden"), "true", "the red dot comes before its word, and is not read");
  const paused = await bar("paused", true);
  assert.deepEqual(words(paused.container), ["Fortsätt", "Stoppa"]);
  assert.ok(text(paused.container, "span", "Pausad"));
  assert.ok(!text(paused.container, "span", "Spelar in"));

  // The fixed line is not in the live region, so a change there does not read it again.
  const plain = await bar("recording", false);
  const notes = [...plain.container.querySelectorAll('[role="status"]')].find((region) => region.textContent?.includes("Låt skärmen vara tänd"));
  assert.ok(notes, "a note is said in a live region that is always there");
  const stop = text(plain.container, "p", "Stoppa avslutar inspelningen. Sedan kan du skapa dokumentet.");
  assert.ok(stop, "the fixed line is shown");
  assert.equal(stop.closest('[role="status"], [aria-live]'), null, "and is in no live region");

  const warned = await bar("recording", false, [{ title: "Vi hör inget från mikrofonen.", detail: "Kontrollera att den inte är avstängd." }]);
  const alert = warned.container.querySelector('[role="alert"]');
  const pause = [...warned.container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Pausa");
  assert.ok(alert && pause, "a warning is an alert");
  assert.ok(alert.compareDocumentPosition(pause) & Node.DOCUMENT_POSITION_FOLLOWING, "above the controls");
  assert.match(alert.textContent ?? "", /Vi hör inget från mikrofonen\./);

  const recorder = await mount(createElement(FocusedRecorder, { capture, phase: "recording", stream: null, storageNote: null }));
  for (const view of [running, recorder]) {
    // Everything inside a live region is checked for the timer, and the timer itself is on the page.
    assert.ok(text(view.container, "span", "0:00"), "the timer is shown");
    for (const region of view.container.querySelectorAll('[role="status"], [aria-live]')) {
      assert.ok(!region.textContent?.includes("0:00"), "the timer is outside every live region");
    }
  }
});

/** A live session that holds one snapshot. */
function liveOf(snapshot: LiveSnapshot): LiveSession {
  return { getSnapshot: () => snapshot, subscribe: () => () => {}, listen: () => {}, setRecording: () => {}, stop: () => {}, dispose: () => {} };
}

test("the live sheet is a named log of committed text; words still arriving are shown, not read", async () => {
  const { createElement } = await import("react");
  const { LiveSheet } = await import("../components/flow/LiveSheet");
  const sheet = async (snapshot: LiveSnapshot) => (await mount(createElement(LiveSheet, { live: liveOf(snapshot), recorder: "recording" }))).container;

  const container = await sheet({
    status: "reconnecting",
    started: true,
    complete: false,
    pieces: [
      { text: "Välkomna till nämndens möte.", opensParagraph: true },
      { text: "Första punkten.", opensParagraph: false },
      { text: "Budgeten.", opensParagraph: true },
    ],
    pending: " Ramen höjs",
  });
  const logs = container.querySelectorAll('[role="log"]');
  assert.equal(logs.length, 1, "one log");
  const log = logs[0];
  assert.equal(log.getAttribute("aria-label"), "Preliminär text");
  assert.equal(log.getAttribute("tabindex"), "0", "focusable, so the keyboard can scroll it");
  assert.equal(log.querySelectorAll("p").length, 2, "a gap starts a new paragraph");
  const pending = log.querySelector('[aria-hidden="true"]');
  assert.equal(pending?.textContent?.trim(), "Ramen höjs", "words still arriving are shown, and not read");
  assert.ok(!log.querySelector('[role="status"]')?.textContent, "nothing of them in a live region");
  const status = log.nextElementSibling;
  assert.equal(status?.getAttribute("role"), "status", "the status line follows the log");
  assert.equal(status?.textContent, "Livetexten pausades. Inspelningen fortsätter.");
  assert.ok(!container.textContent?.includes("Visa senaste"), "following the text: no jump button");

  const empty = await sheet({ status: "connecting", started: false, complete: false, pieces: [], pending: "" });
  assert.match(empty.textContent ?? "", /Texten visas här när du börjar prata\./);
  const emptyStatus = empty.querySelector('[role="log"]')?.nextElementSibling;
  assert.equal(emptyStatus?.getAttribute("role"), "status", "the status region is there before anything is said");
  assert.equal(emptyStatus?.textContent, "", "and says nothing");
  const refused = await sheet({ status: "unavailable", started: false, complete: false, pieces: [], pending: "" });
  assert.ok(!refused.textContent?.includes("Texten visas här"), "no promise of text that will not come");
  assert.match(refused.textContent ?? "", /Livetexten kunde inte starta\./);
});

test("the live sheet shows the relay's final text where a session's deltas were, also when the paragraph keeps its length", async () => {
  const { createElement } = await import("react");
  const { LiveSheet } = await import("../components/flow/LiveSheet");
  const first = { text: "Hej alla.", opensParagraph: true };
  let snapshot: LiveSnapshot = { status: "live", started: true, complete: false, pieces: [first, { text: "Vi börjar", opensParagraph: false }], pending: "" };
  const listeners = new Set<() => void>();
  const live: LiveSession = {
    ...liveOf(snapshot),
    getSnapshot: () => snapshot,
    subscribe: (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
  };
  const view = await mount(createElement(LiveSheet, { live, recorder: "recording" }));
  const log = () => view.container.querySelector('[role="log"]')!.textContent;
  assert.match(log() ?? "", /Hej alla\. Vi börjar/);
  snapshot = { ...snapshot, pieces: [first, { text: "Vi börjar nu.", opensParagraph: false }] };
  await view.act(async () => listeners.forEach((listener) => listener()));
  assert.match(log() ?? "", /Hej alla\. Vi börjar nu\./);
});

test("the live sheet's jump button shows when the reader has scrolled up, and gives the focus to the text it scrolls to", async () => {
  const { createElement } = await import("react");
  const { LiveSheet } = await import("../components/flow/LiveSheet");
  const pieces = [{ text: "Välkomna till nämndens möte.", opensParagraph: true }];
  const view = await mount(createElement(LiveSheet, { live: liveOf({ status: "live", started: true, complete: false, pieces, pending: "" }), recorder: "recording" }));
  const log = view.container.querySelector<HTMLElement>('[role="log"]')!;
  // A text taller than its box, read from the top: jsdom has no layout, so the log says how tall it is.
  let top = 0;
  const scrolls: ScrollToOptions[] = [];
  Object.defineProperty(log, "scrollHeight", { value: 1_000 });
  Object.defineProperty(log, "clientHeight", { value: 400 });
  Object.defineProperty(log, "scrollTop", { get: () => top, set: (value: number) => void (top = value) });
  log.scrollTo = ((options: ScrollToOptions) => {
    scrolls.push(options);
    top = options.top ?? 0;
  }) as typeof log.scrollTo;
  const jump = () => [...view.container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Visa senaste");

  await view.act(async () => log.dispatchEvent(new window.Event("scroll")));
  assert.ok(jump(), "scrolled up to read: the way back to the newest text is offered");
  await view.act(async () => jump()!.click());
  assert.deepEqual(scrolls.map((options) => options.top), [1_000], "scrolls to the end");
  assert.equal(jump(), undefined, "and the button goes away");
  assert.equal(document.activeElement, log, "leaving the focus on the text, not on the page");
  await view.act(async () => log.dispatchEvent(new window.Event("scroll")));
  assert.equal(jump(), undefined, "at the end the reader follows again");
});

test("the live sheet says the speakers come when you are done, only when the flow labels speakers", async () => {
  const { createElement } = await import("react");
  const { LiveSheet } = await import("../components/flow/LiveSheet");
  const { labelsSpeakers } = await import("./flow-session");
  const live = liveOf({ status: "live", started: true, complete: false, pieces: [], pending: "" });
  const heading = async (speakers: boolean) =>
    (await mount(createElement(LiveSheet, { live, recorder: "recording", speakers }))).container.querySelector("h2")?.textContent;
  assert.equal(await heading(true), "Preliminär text. Talare och den slutliga texten kommer när du är klar.");
  assert.equal(await heading(false), "Preliminär text, den slutliga skapas när du är klar");
});
