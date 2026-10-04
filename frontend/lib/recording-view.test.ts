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
  stopLine,
} from "./recording-view";
import { FlowSession } from "./flow-session";
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
  assert.equal(pageTitle("ready", 754_000, "Nämndmöte"), "Inte skickad · Tal till text", "Klart is the finished document's");
  assert.equal(pageTitle("ready", 754_000, "Nämndmöte", true), "Redan skickad · Tal till text", "Eneo already has it");
});

test("a muted or wrong microphone is reported after 15 s of digital silence, and no longer as soon as sound returns", () => {
  const watch = new SilenceWatch();
  // The loudest sample of each read: zeros, as a muted or wrong input gives them.
  assert.equal(watch.update(0, 0), false);
  assert.equal(watch.update(0, 14_900), false);
  assert.equal(watch.update(0, 15_000), true);
  assert.equal(watch.update(0.3, 15_100), false, "sound returns");
  assert.equal(watch.update(0, 15_200), false, "the silence starts over");
  assert.equal(watch.update(1 / 32_768, 30_199), false, "one step of 16-bit audio is still digital silence");
  assert.equal(watch.update(0, 30_200), true);
  watch.reset();
  assert.equal(watch.update(0, 30_300), false, "a pause starts the count over");
});

test("a quiet stretch of a meeting is never reported: a real microphone's room tone is not digital silence", () => {
  const watch = new SilenceWatch();
  // A quiet room through a laptop microphone: peaks around −70 dBFS, far below speech, far above zero.
  const roomTone = 10 ** (-70 / 20);
  for (let now = 0; now <= 10 * 60_000; now += 66) assert.equal(watch.update(roomTone, now), false, `at ${now} ms`);
});

test("while recording for a flow that makes text, the bar's lines speak of the text", () => {
  assert.equal(stopLine(false), "Stoppa avslutar inspelningen. Sedan kan du skapa dokumentet.");
  assert.equal(stopLine(true), "Stoppa avslutar inspelningen. Sedan kan du skapa texten.");
  const { notes } = recordingNotices({
    phase: "recording",
    silent: false,
    lowSpace: false,
    persistent: false,
    refused: null,
    remainingMs: null,
    muted: false,
    wakeLock: true,
    makesText: true,
  });
  assert.deepEqual(notes, ["Inspelningen sparas bara i den här fliken. Stäng inte fliken innan texten är skapad."]);
});

test("the bar warns of what can lose the meeting, and says calmly what else matters now", () => {
  const base = {
    phase: "recording" as const,
    silent: false,
    lowSpace: false,
    persistent: true,
    refused: null,
    remainingMs: null as number | null,
    muted: false,
    wakeLock: true,
  };
  const none = { warnings: [], notes: [] };
  assert.deepEqual(recordingNotices(base), none);
  assert.deepEqual(recordingNotices({ ...base, silent: true }), {
    warnings: [{ title: "Vi hör inget från mikrofonen.", detail: "Kontrollera att den inte är avstängd." }],
    notes: [],
  });
  assert.deepEqual(recordingNotices({ ...base, phase: "paused", silent: true }), none, "no silence warning while paused");
  assert.deepEqual(recordingNotices({ ...base, lowSpace: true, persistent: false, wakeLock: false }), {
    warnings: [{ title: "Det finns lite lagringsutrymme kvar på enheten.", detail: "Frigör utrymme om du ska spela in länge." }],
    notes: [
      "Inspelningen sparas bara i den här fliken. Stäng inte fliken innan dokumentet är skapat.",
      "Låt skärmen vara tänd under inspelningen.",
    ],
  });
  assert.deepEqual(recordingNotices({ ...base, persistent: false, refused: "full" }), {
    warnings: [
      { title: "Enheten har inte plats för att spara mer.", detail: "Inspelningen fortsätter, men välj Spara som fil när du stoppar." },
    ],
    notes: [],
  });
  assert.deepEqual(recordingNotices({ ...base, persistent: false, refused: "failed" }).warnings, [
    { title: "Enheten kan inte spara mer av inspelningen.", detail: "Inspelningen fortsätter, men välj Spara som fil när du stoppar." },
  ]);
  const minutes = (count: number) => count * 60_000;
  const notes = (options: Partial<Parameters<typeof recordingNotices>[0]>) =>
    recordingNotices({ ...base, ...options }).notes;
  assert.deepEqual(notes({ remainingMs: minutes(16) }), [], "nothing yet");
  const fifteen = "Mindre än 15 minuter kvar till flödets maxlängd. Då stoppas inspelningen och det som spelats in sparas.";
  const five = "Mindre än 5 minuter kvar till flödets maxlängd. Då stoppas inspelningen och det som spelats in sparas.";
  assert.deepEqual(notes({ remainingMs: minutes(15) }), [fifteen]);
  assert.deepEqual(notes({ remainingMs: minutes(6) }), [fifteen], "a quiet line, not a count");
  assert.deepEqual(notes({ remainingMs: minutes(5) }), [five]);
  assert.deepEqual(notes({ phase: "paused", remainingMs: minutes(3) }), [five], "while paused too");
  const gone = { title: "Inspelningen pausades när mikrofonen försvann.", detail: "Det som spelats in finns kvar." };
  assert.deepEqual(
    recordingNotices({ ...base, phase: "interrupted", remainingMs: 0 }),
    { warnings: [gone], notes: [] },
    "interrupted, the flow's end is not what the user needs to know",
  );
  assert.deepEqual(recordingNotices({ ...base, muted: true }).warnings, [
    { title: "Mikrofonen är tillfälligt borta.", detail: "Inspelningen fortsätter av sig själv när den är tillbaka." },
  ]);
});

test("recording state changes are announced once, never the timer", () => {
  assert.equal(recordingAnnouncement("setup"), "");
  assert.equal(recordingAnnouncement("starting"), "");
  assert.equal(recordingAnnouncement("recording"), "Spelar in.");
  assert.equal(recordingAnnouncement("paused"), "Inspelningen är pausad.");
  assert.equal(recordingAnnouncement("interrupted"), "", "the recording bar's line says it, once");
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

test("leaving an upload says it stops, and what is kept of a recording", () => {
  assert.equal(leaveWarning(true, "setup", true), "Sändningen avbryts, och filen behöver väljas igen.");
  assert.equal(leaveWarning(true, "ready", true), "Sändningen avbryts. Det som spelats in finns kvar bland osända inspelningar.");
  assert.equal(
    leaveWarning(false, "ready", true),
    "Sändningen avbryts. Inspelningen finns bara i den här fliken och försvinner när du lämnar sidan. Välj Spara som fil först om du vill behålla den.",
  );
});

test("leaving promises the recording back only when the device keeps it, and otherwise says how to keep it", () => {
  for (const phase of ["recording", "paused", "interrupted"] as const) {
    assert.equal(
      leaveWarning(true, phase),
      "Inspelningen stoppas. Det som spelats in finns kvar bland osända inspelningar.",
      "leaving stops the recording: it does not go on in the background",
    );
  }
  for (const persistent of [false, null]) {
    assert.equal(
      leaveWarning(persistent, "recording"),
      "Inspelningen stoppas. Den finns bara i den här fliken och försvinner när du lämnar sidan. Stoppa och välj Spara som fil först om du vill behålla den.",
    );
    assert.equal(
      leaveWarning(persistent, "ready"),
      "Inspelningen finns bara i den här fliken och försvinner när du lämnar sidan. Välj Spara som fil först om du vill behålla den.",
    );
  }
});

test("a flow labels speakers when it says so: switched on, off, required, or not at all", async () => {
  const { labelsSpeakers } = await import("./flow-session");
  const selectable = { selectable: true, required: false, default: true };
  assert.equal(labelsSpeakers(selectable, true), true, "switched on");
  assert.equal(labelsSpeakers(selectable, false), false, "switched off");
  assert.equal(labelsSpeakers({ selectable: false, required: true, default: true }, null), true, "required by the flow");
  assert.equal(labelsSpeakers({ selectable: false, required: false, default: false }, null), false);
  assert.equal(labelsSpeakers(undefined, null), false, "a flow that says nothing");
});

