import assert from "node:assert/strict";
import test from "node:test";

import { formatClock, recordingName } from "./format";
import {
  SilenceWatch,
  atBottom,
  detailsSummary,
  keepDetailsOpen,
  leaveWarning,
  liveStatusLine,
  pageTitle,
  recordingAnnouncement,
  recordingNotices,
} from "./recording-view";
import { guardHistory } from "./leave-guard";
import { FlowSession, type LiveSession } from "./flow-session";
import type { LiveSnapshot } from "./live-transcriber";
import { openRecordingStore } from "./recording-store";

test("the timer reads m:ss under an hour and h:mm:ss from an hour", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(9_999), "0:09");
  assert.equal(formatClock(754_000), "12:34");
  assert.equal(formatClock(3_599_999), "59:59");
  assert.equal(formatClock(3_600_000), "1:00:00");
  assert.equal(formatClock(3_725_000), "1:02:05");
});

test("the tab title follows the state, so a user in another tab sees that recording runs", () => {
  assert.equal(pageTitle("setup", 0, "Nämndmöte till rapport"), "Nämndmöte till rapport · Tal till text");
  assert.equal(pageTitle("recording", 754_000, "Nämndmöte"), "Spelar in 12:34 · Tal till text");
  assert.equal(pageTitle("paused", 754_000, "Nämndmöte"), "Pausad · Tal till text");
  assert.equal(pageTitle("interrupted", 754_000, "Nämndmöte"), "Pausad · Tal till text");
  assert.equal(pageTitle("ready", 754_000, "Nämndmöte"), "Klart · Tal till text");
});

test("silence is reported after about 15 s without sound, and gone as soon as sound returns", () => {
  const watch = new SilenceWatch();
  assert.equal(watch.update(0.02, 0), false);
  assert.equal(watch.update(0.02, 14_900), false);
  assert.equal(watch.update(0.02, 15_000), true);
  assert.equal(watch.update(0.6, 15_100), false, "sound returns");
  assert.equal(watch.update(0.02, 15_200), false, "the quiet starts over");
  assert.equal(watch.update(0.02, 30_199), false);
  assert.equal(watch.update(0.02, 30_200), true);
  watch.reset();
  assert.equal(watch.update(0.02, 30_300), false, "a pause starts the count over");
});

test("the bar's line says what matters now, calmly, and always what Stoppa does", () => {
  const base = { phase: "recording" as const, silent: false, lowSpace: false, persistent: true, wakeLock: true };
  const stop = "Stoppa avslutar inspelningen. Du väljer sedan att skapa dokumentet.";
  assert.deepEqual(recordingNotices(base), [stop]);
  assert.deepEqual(recordingNotices({ ...base, silent: true }), [
    "Vi hör inget ljud. Kontrollera att mikrofonen är på.",
    stop,
  ]);
  assert.deepEqual(recordingNotices({ ...base, phase: "paused", silent: true }), [stop], "no silence warning while paused");
  assert.deepEqual(recordingNotices({ ...base, lowSpace: true, persistent: false, wakeLock: false }), [
    "Det finns lite lagringsutrymme kvar på enheten. Frigör utrymme om du ska spela in länge.",
    "Inspelningen sparas bara i den här fliken. Stäng inte fliken innan dokumentet är skapat.",
    "Låt skärmen vara tänd under inspelningen.",
    stop,
  ]);
  assert.deepEqual(recordingNotices({ ...base, phase: "interrupted" }), [
    "Inspelningen pausades när mikrofonen försvann. Det som spelats in finns kvar.",
    stop,
  ]);
});

test("recording state changes are announced once, never the timer", () => {
  assert.equal(recordingAnnouncement("setup"), "");
  assert.equal(recordingAnnouncement("starting"), "");
  assert.equal(recordingAnnouncement("recording"), "Spelar in.");
  assert.equal(recordingAnnouncement("paused"), "Inspelningen är pausad.");
  assert.equal(recordingAnnouncement("interrupted"), "Inspelningen pausades när mikrofonen försvann. Det som spelats in finns kvar.");
  assert.equal(recordingAnnouncement("ready"), "", "focus on the ready heading says it");
});

test("the details collapse to one line that names what is filled in", () => {
  const fields = [
    { name: "deltagare", label: "Deltagare", type: "list" },
    { name: "motesnamn", label: "Mötets namn", type: "text" },
    { name: "datum", label: "Datum", type: "date" },
  ];
  assert.equal(
    detailsSummary(fields, { deltagare: ["Anna Berg", "Erik Lund", "Sara Holm"], motesnamn: "KS" }),
    "Deltagare: Anna Berg, Erik Lund, Sara Holm · Mötets namn: KS",
  );
  assert.equal(detailsSummary(fields, { deltagare: [] }), "Inga uppgifter ifyllda");
});

test("pause excludes time: the timer counts only recorded time", async () => {
  // The recorder's own monotonic clock, moved by hand.
  let clock = 1_000_000;
  const tick = (ms: number) => void (clock += ms);
  const recorders: Array<EventTarget & { state: string }> = [];
  const session = new FlowSession({
    flowId: "flow-1",
    flowName: "Nämndmöte",
    ownerId: "user-1",
    openStore: () => openRecordingStore({}),
    captureDeps: {
      now: () => clock,
      getStream: async () =>
        ({ getTracks: () => [], getAudioTracks: () => [] }) as unknown as MediaStream,
      createRecorder: () => {
        const recorder = Object.assign(new EventTarget(), {
          state: "inactive",
          start() {
            recorder.state = "recording";
          },
          pause() {
            recorder.state = "paused";
          },
          resume() {
            recorder.state = "recording";
          },
          stop() {},
          requestData() {},
        });
        recorders.push(recorder);
        return recorder as unknown as MediaRecorder;
      },
    },
    pickMimeType: () => "audio/webm",
  });
  session.setContract({
    flow_id: "flow-1",
    published_flow_version: 1,
    steps_requiring_input: [{ step_id: "step-audio", input_format: "audio" }],
  });
  session.selectMode("spela-in");
  await session.start();
  tick(5_000);
  assert.equal(session.capture.elapsedMs(), 5_000);
  session.togglePause();
  tick(10_000);
  assert.equal(session.capture.elapsedMs(), 5_000, "paused time is not counted");
  session.togglePause();
  tick(3_000);
  assert.equal(session.capture.elapsedMs(), 8_000);
});

/** A window with history, as far as the guard uses it. */
function fakeWindow() {
  // The flow list, then the flow page.
  const entries: unknown[] = [{ page: "list" }, { page: "flow" }];
  let index = 1;
  const target = new EventTarget();
  const history = {
    get state() {
      return entries[index];
    },
    pushState(state: unknown) {
      entries.splice(index + 1);
      entries.push(state);
      index += 1;
    },
    go(delta: number) {
      const next = Math.max(0, Math.min(entries.length - 1, index + delta));
      if (next === index) return;
      index = next;
      queueMicrotask(() => target.dispatchEvent(Object.assign(new Event("popstate"), { state: entries[index] })));
    },
    back() {
      history.go(-1);
    },
  };
  return {
    win: Object.assign(target, { history }) as unknown as Pick<Window, "history" | "addEventListener" | "removeEventListener">,
    entries,
    get index() {
      return index;
    },
    /** The browser's back button. */
    pressBack: () => history.back(),
  };
}

const settleEvents = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test("browser back during a recording keeps the page and asks; staying needs nothing, leaving goes on back", async () => {
  const browser = fakeWindow();
  const attempts: Array<() => void> = [];
  const release = guardHistory(browser.win, (leave) => attempts.push(leave));
  assert.equal(browser.index, 2, "a guard entry is added");

  browser.pressBack();
  await settleEvents();
  assert.equal(attempts.length, 1, "the page asks");
  assert.equal(browser.index, 2, "the page stays guarded while the question is open, and after Stanna kvar");

  browser.pressBack();
  await settleEvents();
  assert.equal(attempts.length, 2);
  attempts[1]();
  await settleEvents();
  assert.equal(browser.index, 0, "Lämna sidan goes on back to the list");
  release();
});

test("when the recording is done with, the guard takes its history entry back", async () => {
  const browser = fakeWindow();
  const release = guardHistory(browser.win, () => undefined);
  assert.equal(browser.index, 2);
  release();
  await settleEvents();
  assert.equal(browser.index, 1, "back on the flow page's own entry");
});

test("the bar keeps Pausa and Stoppa in place, says Fortsätt while paused, and the timer is never in a live region", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
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
  const bar = (phase: "recording" | "paused", showStatus: boolean) =>
    renderToStaticMarkup(
      createElement(RecordingBar, {
        capture,
        phase,
        stream: null,
        showStatus,
        notices: ["Stoppa avslutar inspelningen. Du väljer sedan att skapa dokumentet."],
        onPause: () => {},
        onStop: () => {},
      }),
    );
  const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(?:<svg.*?<\/svg>)?([^<]+)<\/button>/g)].map(([, label]) => label);
  assert.deepEqual(buttons(bar("recording", true)), ["Pausa", "Stoppa"]);
  assert.deepEqual(buttons(bar("paused", true)), ["Fortsätt", "Stoppa"]);
  assert.match(bar("recording", true), /<span aria-hidden="true" class="[^"]*bg-record[^"]*"><\/span>Spelar in/, "the red dot has its word");
  assert.match(bar("paused", true), />Pausad</);

  const recorder = renderToStaticMarkup(
    createElement(FocusedRecorder, { capture, phase: "recording", stream: null, storageNote: null }),
  );
  for (const html of [bar("recording", true), recorder]) {
    // Everything inside a live region, and the timer text itself.
    const live = [...html.matchAll(/<(\w+)[^>]*(?:role="status"|aria-live)[^>]*>(.*?)<\/\1>/gs)].map(([, , inner]) => inner);
    assert.ok(html.includes(">0:00<"), "the timer is shown");
    assert.ok(live.every((inner) => !inner.includes("0:00")), "the timer is outside every live region");
  }
});

test("a recording is named for people", () => {
  assert.equal(recordingName(new Date(2026, 8, 23, 16, 13).getTime()), "Inspelning 23 sep 16:13");
  assert.equal(recordingName(new Date(2026, 4, 2, 9, 5).getTime()), "Inspelning 2 maj 09:05");
});

test("the live sheet follows new text only while the reader is at the bottom", () => {
  assert.equal(atBottom({ scrollTop: 600, clientHeight: 400, scrollHeight: 1_000 }), true);
  assert.equal(atBottom({ scrollTop: 580, clientHeight: 400, scrollHeight: 1_000 }), true, "a few pixels short still counts");
  assert.equal(atBottom({ scrollTop: 300, clientHeight: 400, scrollHeight: 1_000 }), false, "scrolled up to read: keep the place");
  assert.equal(atBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 300 }), true, "nothing to scroll");
});

test("live text says what it is doing apart from the recording, and only while the recorder records", () => {
  assert.equal(liveStatusLine("reconnecting", true, "recording"), "Livetexten pausades. Inspelningen fortsätter.");
  assert.equal(liveStatusLine("reconnecting", true, "paused"), null, "a paused recorder is not claimed to record");
  assert.equal(liveStatusLine("reconnecting", true, "interrupted"), null);
  assert.equal(
    liveStatusLine("unavailable", false, "recording"),
    "Livetexten kunde inte starta. Inspelningen fortsätter, och texten skapas när du stoppar.",
  );
  assert.equal(
    liveStatusLine("reconnecting", false, "recording"),
    "Livetexten kan inte starta just nu. Inspelningen fortsätter.",
    "not yet started: nothing was paused",
  );
  assert.equal(
    liveStatusLine("stopped", true, "recording"),
    "Livetexten stannade. Inspelningen fortsätter, och texten skapas när du stoppar.",
  );
  assert.equal(liveStatusLine("live", true, "recording"), null);
  assert.equal(liveStatusLine("connecting", false, "recording"), null);
});

test("the live sheet is a named log of committed text; words still arriving are shown, not read", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { LiveSheet } = await import("../components/flow/LiveSheet");
  const sheet = (snapshot: LiveSnapshot) => {
    const live: LiveSession = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      listen: () => {},
      setRecording: () => {},
      stop: () => {},
      dispose: () => {},
    };
    return renderToStaticMarkup(createElement(LiveSheet, { live, recorder: "recording" }));
  };

  const html = sheet({
    status: "reconnecting",
    started: true,
    pieces: [
      { text: "Välkomna till nämndens möte.", opensParagraph: true },
      { text: "Första punkten.", opensParagraph: false },
      { text: "Budgeten.", opensParagraph: true },
    ],
    pending: " Ramen höjs",
  });
  const log = html.match(/<div[^>]*role="log"[^>]*>(.*)<\/div><p role="status"/s);
  assert.ok(log, "one log, followed by the status line");
  assert.match(log[0], /aria-label="Preliminär text"/);
  assert.equal([...log[1].matchAll(/<p>/g)].length, 2, "a gap starts a new paragraph");
  assert.match(log[1], /<span aria-hidden="true" class="text-muted-foreground"> Ramen höjs<\/span>/);
  assert.match(html, /<p role="status"[^>]*>Livetexten pausades\. Inspelningen fortsätter\.<\/p>/);
  assert.ok(!html.includes("Visa senaste"), "following the text: no jump button");

  const empty = sheet({ status: "connecting", started: false, pieces: [], pending: "" });
  assert.match(empty, /Texten visas här när du börjar prata\./);
  assert.match(empty, /<p role="status" class="sr-only"><\/p>/, "the status region is there before anything is said");
  const refused = sheet({ status: "unavailable", started: false, pieces: [], pending: "" });
  assert.ok(!refused.includes("Texten visas här"), "no promise of text that will not come");
  assert.match(refused, /Livetexten kunde inte starta\./);
});

test("details a send found missing stay unfolded while they are filled in, until the user folds them", () => {
  let open = keepDetailsOpen(false, []);
  assert.equal(open, false, "folded to one line while recording");
  open = keepDetailsOpen(open, ["motesnamn"]); // Skapa dokument finds the meeting's name missing
  assert.equal(open, true);
  open = keepDetailsOpen(open, []); // the first character fills it in
  assert.equal(open, true, "the field being typed in stays in view");
  open = false; // the user folds them
  assert.equal(keepDetailsOpen(open, []), false);
});

test("leaving promises the recording back only when the device keeps it, and otherwise says how to keep it", () => {
  assert.equal(leaveWarning(true, "recording"), "Det som spelats in finns kvar bland osända inspelningar.");
  for (const persistent of [false, null]) {
    assert.equal(
      leaveWarning(persistent, "recording"),
      "Inspelningen finns bara i den här fliken och försvinner när du lämnar sidan. Stoppa och välj Spara som fil först om du vill behålla den.",
    );
    assert.equal(
      leaveWarning(persistent, "ready"),
      "Inspelningen finns bara i den här fliken och försvinner när du lämnar sidan. Välj Spara som fil först om du vill behålla den.",
    );
  }
});
