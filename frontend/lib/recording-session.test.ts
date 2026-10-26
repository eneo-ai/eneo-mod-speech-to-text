import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";

import {
  NOT_ON_DEVICE,
  openRecordingStore,
  type NewRecording,
  type RecordingFile,
  type RecordingStore,
} from "./recording-store";
import { fakeWebLocks } from "./fake-web-locks";
import { createOnlineStatus } from "./online-status";
import { asksBeforeClosing, recordingNotices } from "./recording-view";
import { mayContinue, RecordingCapture, type CaptureDeps, type PageLike } from "./recording-session";
import { submitRecording } from "./submit-run";

const meeting: NewRecording = {
  ownerId: "user-1",
  flowId: "flow-1",
  flowName: "Nämndmöte till rapport",
  stepId: "step-audio",
  inputMode: "record",
  mimeType: "audio/webm;codecs=opus",
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function until(condition: () => boolean | Promise<boolean>, what = "condition") {
  for (let i = 0; i < 1_000; i += 1) {
    if (await condition()) return;
    await settle();
  }
  assert.fail(`${what} never happened`);
}

const texts = (files: RecordingFile[]) => Promise.all(files.map((file) => file.blob.text()));

class FakeTrack extends EventTarget {
  readonly kind = "audio";
  readyState: MediaStreamTrackState = "live";
  muted = false;
  stop() {
    this.readyState = "ended";
  }
  lose(how: "ended" | "mute") {
    if (how === "ended") this.readyState = "ended";
    else this.muted = true;
    this.dispatchEvent(new Event(how));
  }
  /** The same track gives sound again (a headset back on its route). */
  regain() {
    this.muted = false;
    this.dispatchEvent(new Event("unmute"));
  }
}

class FakeStream {
  readonly track = new FakeTrack();
  getTracks() {
    return [this.track];
  }
  getAudioTracks() {
    return [this.track];
  }
}

class FakeRecorder extends EventTarget {
  state: "inactive" | "recording" | "paused" = "inactive";
  timeslice: number | undefined;
  flushes = 0;
  // What it hands over at its stop: nothing when it stopped before recording anything.
  lastData = ".";
  readonly mimeType: string;
  constructor(
    readonly stream: FakeStream,
    readonly options: MediaRecorderOptions,
  ) {
    super();
    this.mimeType = options.mimeType ?? "";
  }
  start(timeslice?: number) {
    this.state = "recording";
    this.timeslice = timeslice;
  }
  pause() {
    this.state = "paused";
  }
  resume() {
    this.state = "recording";
  }
  requestData() {
    this.flushes += 1;
  }
  emit(text: string) {
    this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: new Blob([text]) }));
  }
  /** Like the browser: the last data, then "stop", after the current task. */
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    setImmediate(() => {
      this.emit(this.lastData);
      this.dispatchEvent(new Event("stop"));
    });
  }
}

function fakePage() {
  const page = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
  });
  return {
    page: page as PageLike,
    show(state: DocumentVisibilityState) {
      page.visibilityState = state;
      page.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

// A recording a test leaves running is left as a page would leave it, and its recorders' stops land before the
// next test (which may mock the timers), so no handover timer outlives the test.
const captures: RecordingCapture[] = [];
afterEach(async () => {
  captures.splice(0).forEach((capture) => capture.dispose());
  for (let i = 0; i < 5; i += 1) await settle();
});

async function setup(
  options: {
    store?: RecordingStore;
    page?: PageLike;
    window?: EventTarget;
    now?: () => number;
    /** A denied microphone, or one the browser grants only once `wait` settles. */
    microphone?: { denied?: boolean; wait?: Promise<void>; refusal?: string };
    /** The screen's wake lock is granted only once this settles. */
    wakeLock?: Promise<void>;
    /** The browser's own answer to a wake lock request, in place of one that grants every request. */
    requestWakeLock?: CaptureDeps["requestWakeLock"];
  } = {},
) {
  const store = options.store ?? (await openRecordingStore({}));
  const streams: FakeStream[] = [];
  const constraints: MediaStreamConstraints[] = [];
  const recorders: FakeRecorder[] = [];
  const wakeLocks = { requested: 0, released: 0 };
  // Every request for the microphone, counted as it is made: in the same task as the press, or later.
  let requests = 0;
  const deps: CaptureDeps = {
    getStream: async (asked) => {
      requests += 1;
      if (options.microphone?.denied) throw new DOMException("Permission denied", "NotAllowedError");
      if (options.microphone?.refusal) throw new DOMException("The microphone could not start", options.microphone.refusal);
      await options.microphone?.wait;
      constraints.push(asked);
      const stream = new FakeStream();
      streams.push(stream);
      return stream as unknown as MediaStream;
    },
    createRecorder: (stream, recorderOptions) => {
      const recorder = new FakeRecorder(stream as unknown as FakeStream, recorderOptions);
      recorders.push(recorder);
      return recorder as unknown as MediaRecorder;
    },
    now: options.now,
    requestWakeLock:
      options.requestWakeLock ??
      (async () => {
        wakeLocks.requested += 1;
        await options.wakeLock;
        return {
          release: async () => {
            wakeLocks.released += 1;
          },
        };
      }),
    page: options.page,
    window: options.window as CaptureDeps["window"],
  };
  const capture = new RecordingCapture(() => store, deps);
  captures.push(capture);
  return { capture, store, streams, constraints, recorders, wakeLocks, requests: () => requests };
}

test("losing the microphone pauses the recording, keeps what was recorded, and 'Fortsätt spela in' records a new part", async () => {
  const { capture, store, streams, recorders } = await setup();
  await capture.start(meeting);
  assert.equal(capture.getSnapshot().status, "recording");
  assert.equal(recorders[0].timeslice, 2_000);
  assert.equal(recorders[0].mimeType, "audio/webm;codecs=opus");
  recorders[0].emit("a");
  recorders[0].emit("b");

  streams[0].track.lose("ended"); // another app takes the microphone for good
  await until(() => capture.getSnapshot().status === "interrupted", "the pause");
  const paused = capture.getSnapshot().recording;
  assert.equal(paused?.state, "paused");
  assert.equal(streams[0].track.readyState, "ended", "the microphone is let go");
  assert.deepEqual(await texts(await store.readParts(paused!.id)), ["ab."]);
  assert.deepEqual(await store.listUnsent("user-1"), [], "a paused recording still belongs to this page");

  await capture.continueRecording();
  assert.equal(capture.getSnapshot().status, "recording");
  assert.equal(streams.length, 2, "a fresh microphone stream");
  recorders[1].emit("c");
  const stopped = await capture.stop();
  assert.equal(stopped?.state, "stopped");
  assert.deepEqual(await texts(await store.readParts(stopped!.id)), ["ab.", "c."]);
  assert.equal(capture.getSnapshot().status, "stopped");
});

test("a microphone that goes quiet for a moment (a headset changing route) keeps recording, says so, and is back by itself", async () => {
  const { capture, recorders, streams } = await setup();
  await capture.start(meeting);
  recorders[0].emit("a");
  streams[0].track.lose("mute");
  assert.equal(capture.getSnapshot().status, "recording", "not a stop: the meeting goes on");
  assert.equal(capture.getSnapshot().muted, true, "and the page says the microphone is away");
  assert.equal(recorders[0].state, "recording");
  streams[0].track.regain();
  assert.equal(capture.getSnapshot().muted, false, "back by itself, without Fortsätt");
  assert.equal(capture.getSnapshot().status, "recording");
  assert.equal(recorders.length, 1, "the same part goes on");
});

test("back on a page whose microphone went quiet while hidden, the recording goes on and says so until the sound is back", async () => {
  const { page, show } = fakePage();
  const { capture, streams } = await setup({ page });
  await capture.start(meeting);
  show("hidden");
  streams[0].track.muted = true; // muted while hidden, without an event reaching the page
  show("visible");
  await settle();
  assert.equal(capture.getSnapshot().status, "recording");
  assert.equal(capture.getSnapshot().muted, true);
  streams[0].track.regain();
  assert.equal(capture.getSnapshot().muted, false);
});

/** The intervals set and not yet cleared: a capture's watch must not outlive it. */
function liveIntervals(t: import("node:test").TestContext) {
  const live = new Set<unknown>();
  const set = globalThis.setInterval;
  const clear = globalThis.clearInterval;
  globalThis.setInterval = ((run: () => void, ms?: number) => {
    const id = set(run, ms);
    live.add(id);
    return id;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id?: Parameters<typeof clearInterval>[0]) => {
    live.delete(id);
    clear(id);
  }) as typeof clearInterval;
  t.after(() => {
    globalThis.setInterval = set;
    globalThis.clearInterval = clear;
  });
  return live;
}

test("a recorder that hands over no audio is asked for it once, then the page says nothing is kept, until audio comes again", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const intervals = liveIntervals(t);
  const { page, show } = fakePage();
  const { capture, recorders } = await setup({ page });
  await capture.start(meeting);
  const look = (times = 1) => t.mock.timers.tick(2_000 * times);
  look(2);
  assert.equal(recorders[0].flushes, 0, "a chunk may still be on its way");
  look();
  assert.equal(recorders[0].flushes, 1, "six seconds without audio: the recorder is asked for it");
  assert.equal(capture.getSnapshot().stalled, false);
  look();
  assert.equal(capture.getSnapshot().stalled, true, "still nothing: said");
  look(5);
  assert.equal(recorders[0].flushes, 1, "asked once");
  recorders[0].emit("a");
  assert.equal(capture.getSnapshot().stalled, false, "audio again: the warning goes");

  // A page in the background is not watched (a phone holds its recorder's audio back); in view again it starts over.
  show("hidden");
  const flushes = recorders[0].flushes;
  look(10);
  show("visible");
  look(2);
  assert.deepEqual([recorders[0].flushes, capture.getSnapshot().stalled], [flushes, false]);
  // Paused, the recorder has nothing to hand over; going on starts the count over.
  capture.togglePause();
  look(10);
  capture.togglePause();
  look(2);
  assert.deepEqual([recorders[0].flushes, capture.getSnapshot().stalled], [flushes, false]);

  assert.equal(intervals.size, 1, "one watch");
  await capture.stop();
  assert.equal(intervals.size, 0, "it ends with Stoppa");
  look(10);
  assert.equal(recorders[0].flushes, flushes);
  await capture.start(meeting);
  capture.dispose();
  assert.equal(intervals.size, 0, "and when the page goes");
});

test("a recorder that stops without saying so is a lost microphone: the recording pauses with what it has, and keeps audio handed over late", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { capture, store, recorders } = await setup();
  await capture.start(meeting);
  recorders[0].emit("a");
  recorders[0].state = "inactive"; // no last data, no stop event yet (WebKit after an interruption)
  t.mock.timers.tick(2_000); // the look that finds it stopped
  assert.equal(capture.getSnapshot().status, "recording", "its last audio and its stop event may still be on their way");
  t.mock.timers.tick(2_000);
  recorders[0].emit("b"); // its last audio, late
  t.mock.timers.tick(3_000);
  for (let i = 0; i < 5; i += 1) await settle();
  assert.equal(capture.getSnapshot().status, "recording", "audio came: its stop event may still come too");
  t.mock.timers.tick(1_000);
  await until(() => capture.getSnapshot().status === "interrupted", "the pause, without a stop event");
  recorders[0].emit("c"); // later still
  const { id } = capture.getSnapshot().recording!;
  await until(async () => (await texts(await store.readParts(id)))[0] === "abc", "every chunk the recorder handed over is kept");
});

test("a device's storage that never answers does not hold Stoppa: after a while the recording is stopped, with what failed said", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { capture, store, recorders } = await setup();
  await capture.start(meeting);
  recorders[0].emit("a");
  // IndexedDB that stops answering (WebKit has hung instead of failing): the state is never written.
  store.setState = () => new Promise<void>(() => undefined);
  const stopping = capture.stop();
  await settle();
  assert.equal(capture.getSnapshot().stopping, true);
  t.mock.timers.tick(10_000);
  await until(() => capture.getSnapshot().stopping === false, "Stoppa ends without the device's word");
  await stopping;
  assert.equal(capture.getSnapshot().status, "stopped", "the ready view, with Spara ljudfil, is reachable");
  assert.ok(capture.getSnapshot().recording, "the recording the page holds");
  assert.equal(capture.getSnapshot().error, "Inspelningen stoppades, men det gick inte att bekräfta att den sparades på enheten.");
});

test("Stoppa whose last audio the device has not taken yet keeps the browser's question on closing the tab, until the device has it, and the recording on this page until it lets it go", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const device = { indexedDB: new IDBFactory(), keyRange: IDBKeyRange, locks: fakeWebLocks() };
  const store = await openRecordingStore(device);
  const otherTab = await openRecordingStore(device);
  const { capture, recorders } = await setup({ store });
  await capture.start(meeting);
  recorders[0].emit("a");
  // The device stops answering at the next audio (WebKit's IndexedDB has hung instead of failing): its write waits.
  let land: (() => void) | undefined;
  const late = new Blob(["b"]);
  const stuck = Object.assign(new Blob(["b"]), {
    arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => (land = () => void late.arrayBuffer().then(resolve))),
  });
  recorders[0].dispatchEvent(Object.assign(new Event("dataavailable"), { data: stuck }));
  const stopping = capture.stop();
  await until(() => land !== undefined, "the write that waits");
  for (let i = 0; i < 5; i += 1) await settle();
  t.mock.timers.tick(10_000);
  await stopping;
  const closing = () => {
    const { persistent, refused } = capture.getSnapshot();
    return asksBeforeClosing({ phase: "ready", persistent, refused, finishing: false, sending: false, unstored: false });
  };
  assert.equal(capture.getSnapshot().status, "stopped");
  assert.equal(closing(), true, "closing the tab asks: the device has not said it has the last audio");
  // The device answers after all: it keeps the whole recording, and closing the tab loses nothing.
  land!();
  await until(() => !closing(), "the device's word");
  const { id } = capture.getSnapshot().recording!;
  assert.deepEqual(await texts(await store.readPartsToSend(id)), ["ab."]);
  for (let i = 0; i < 5; i += 1) await settle(); // the recorder's queued writes are done, and it lets go of them

  // The ready view still offers Spara and Skicka: another tab of the same person neither offers it nor deletes it.
  const groups = await otherTab.listUnsentGroups("user-1");
  assert.deepEqual([groups.offered.map((r) => r.id), groups.elsewhere.map((r) => r.id)], [[], [id]], "held by the page that shows it");
  await assert.rejects(otherTab.remove(id), /används i en annan flik/);
  // "Spela in på nytt": the page lets it go, and the other tab offers it.
  capture.reset();
  assert.deepEqual((await otherTab.listUnsent("user-1")).map((r) => r.id), [id]);
});

test("a recorder that never confirms its end holds neither Stoppa nor a page that goes: the part ends unconfirmed after a while, and audio still kept", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const silentStop = (recorder: FakeRecorder) => (recorder.stop = () => void (recorder.state = "inactive"));
  const { capture, store, streams, recorders } = await setup();
  await capture.start(meeting);
  recorders[0].emit("a");
  silentStop(recorders[0]);
  const stopping = capture.stop();
  assert.equal(streams[0].track.readyState, "ended", "the microphone goes at once");
  t.mock.timers.tick(3_000);
  await settle();
  assert.equal(capture.getSnapshot().stopping, true, "its last audio may still come");
  t.mock.timers.tick(1_000);
  await until(() => capture.getSnapshot().status === "stopped", "Stoppa ends without the recorder's word");
  const stopped = await stopping;
  assert.equal(stopped?.state, "stopped");
  assert.equal(capture.getSnapshot().stopping, false);
  assert.equal(capture.getSnapshot().error, "Inspelningen stoppades, men webbläsaren bekräftade inte att de sista sekunderna sparades.");
  recorders[0].emit("b"); // its last audio after all
  await until(async () => (await texts(await store.readParts(stopped!.id)))[0] === "ab", "audio handed over after the end is kept");

  const left = await setup();
  await left.capture.start(meeting);
  left.recorders[0].emit("a");
  silentStop(left.recorders[0]);
  const { id } = left.capture.getSnapshot().recording!;
  left.capture.dispose();
  t.mock.timers.tick(4_000);
  await until(async () => (await left.store.get(id))?.state === "paused", "the page that went leaves it paused, for recovery");
});

test("an unconfirmed stop keeps its time, follows late-only audio, and cannot submit until the recorder confirms", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let now = 0;
  const { capture, store, recorders } = await setup({ now: () => now });
  await capture.start(meeting);
  now = 60_000;
  recorders[0].stop = () => void (recorders[0].state = "inactive");
  const stopping = capture.stop();
  now = 64_000;
  t.mock.timers.tick(4_000);
  const stopped = (await stopping)!;
  await assert.rejects(store.readPartsToSend(stopped.id), /bekräfta.*stopp|bekräftat.*stopp/);
  recorders[0].emit("late-only");
  await until(() => capture.getSnapshot().recording?.parts[0]?.bytes === 9, "ready metadata follows late audio");
  assert.equal(capture.getSnapshot().recording?.durationMs, 60_000);
  await store.accept(stopped.id, "run-must-not-delete");
  assert.ok(await store.get(stopped.id), "unconfirmed audio survives acceptance");
  recorders[0].dispatchEvent(new Event("stop"));
  await until(async () => {
    try { return (await store.readPartsToSend(stopped.id)).length === 1; } catch { return false; }
  }, "confirmed audio can be submitted");
  assert.deepEqual(await texts(await store.readPartsToSend(stopped.id)), ["late-only"]);
});

test("an unconfirmed interruption is still warned about after Stoppa", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { capture, recorders } = await setup();
  await capture.start(meeting);
  recorders[0].emit("a");
  recorders[0].state = "inactive";
  t.mock.timers.tick(2_000);
  t.mock.timers.tick(4_000);
  await until(() => capture.getSnapshot().status === "interrupted");
  assert.match(capture.getSnapshot().error ?? "", /bekräftade inte/);
  await capture.stop();
  assert.match(capture.getSnapshot().error ?? "", /bekräftade inte/);
});

test("late callbacks from a deleted recording cannot report errors against a new capture", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { capture, store, recorders } = await setup();
  await capture.start(meeting);
  recorders[0].stop = () => void (recorders[0].state = "inactive");
  const stopping = capture.stop();
  t.mock.timers.tick(4_000);
  const old = (await stopping)!;
  capture.reset();
  await store.discard(old.id);
  await capture.start(meeting);
  recorders[0].emit("old audio");
  for (let i = 0; i < 20; i += 1) await settle();
  assert.equal(capture.getSnapshot().status, "recording");
  assert.equal(capture.getSnapshot().error, null);
  recorders[1].emit("new audio");
  await until(async () => (await texts(await store.readParts(capture.getSnapshot().recording!.id)))[0] === "new audio");
});

test("a microphone muted while the page was away is told with how long once the page is back; muted long in view, the page says to act", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let now = 0;
  const { page, show } = fakePage();
  const { capture, streams } = await setup({ page, now: () => now });
  await capture.start(meeting);
  show("hidden");
  streams[0].track.lose("mute"); // the phone takes the microphone from a page in the background
  now = 40_000;
  streams[0].track.regain();
  assert.equal(capture.getSnapshot().mutedGap, null, "not told to a page nobody sees");
  show("visible");
  assert.deepEqual(capture.getSnapshot().mutedGap, { ms: 40_000, away: true });
  show("hidden");
  assert.equal(capture.getSnapshot().mutedGap, null, "told until the page goes away again");
  show("visible");

  streams[0].track.lose("mute");
  now += 1_000;
  streams[0].track.regain();
  assert.equal(capture.getSnapshot().mutedGap, null, "a second's route change is not told");
  streams[0].track.lose("mute");
  t.mock.timers.tick(14_000);
  assert.equal(capture.getSnapshot().mutedLong, false);
  t.mock.timers.tick(2_000);
  assert.equal(capture.getSnapshot().mutedLong, true, "muted 15 s in view");
  assert.equal(capture.getSnapshot().stalled, false, "a muted microphone is not a stalled recorder");
  now += 20_000;
  streams[0].track.regain();
  assert.equal(capture.getSnapshot().mutedLong, false);
  assert.deepEqual(capture.getSnapshot().mutedGap, { ms: 20_000, away: false });
});

test("a page back from the background, where the recorder handed over no audio, is told how long it was away; with audio meanwhile nothing is said", async () => {
  let now = 0;
  const { page, show } = fakePage();
  const { capture, streams, recorders } = await setup({ page, now: () => now });
  await capture.start(meeting);
  // A phone takes the microphone from a page in the background without a word (Android: no mute).
  show("hidden");
  recorders[0].emit("a"); // what the page asked for as it went
  now = 12_000;
  show("visible");
  assert.equal(capture.getSnapshot().hiddenGap, 12_000);
  show("hidden");
  assert.equal(capture.getSnapshot().hiddenGap, null, "told until the page goes away again");

  // A laptop's background tab records on: its chunks come, and there is nothing to tell.
  for (const text of ["b", "c", "d"]) recorders[0].emit(text);
  now += 12_000;
  show("visible");
  assert.equal(capture.getSnapshot().hiddenGap, null);
  show("hidden");
  now += 3_000;
  show("visible");
  assert.equal(capture.getSnapshot().hiddenGap, null, "a moment away is no gap");

  // Muted meanwhile: the muted microphone is told, once.
  show("hidden");
  streams[0].track.lose("mute");
  now += 10_000;
  streams[0].track.regain();
  show("visible");
  assert.deepEqual([capture.getSnapshot().mutedGap, capture.getSnapshot().hiddenGap], [{ ms: 10_000, away: true }, null]);
});

test("a muted microphone misses only recorded time: a mute within Pausa is not told, and one across it counts the recording on either side", async () => {
  let now = 0;
  const { capture, streams } = await setup({ now: () => now });
  await capture.start(meeting);
  capture.togglePause();
  streams[0].track.lose("mute");
  now = 20_000;
  streams[0].track.regain();
  assert.equal(capture.getSnapshot().mutedGap, null, "paused, nothing was missed");

  capture.togglePause();
  streams[0].track.lose("mute");
  now = 25_000; // five recorded seconds muted
  capture.togglePause();
  now = 45_000;
  capture.togglePause();
  now = 48_000; // and three more
  streams[0].track.regain();
  assert.deepEqual(capture.getSnapshot().mutedGap, { ms: 8_000, away: false });
});

test("a microphone that ends, or a recorder that stops or fails by itself, pauses the recording too", async () => {
  const losses: Array<[string, (stream: FakeStream, recorder: FakeRecorder) => void]> = [
    ["the track ended", (stream) => stream.track.lose("ended")],
    ["the browser stopped the recorder", (_stream, recorder) => recorder.stop()],
    ["the recorder failed", (_stream, recorder) => recorder.dispatchEvent(new Event("error"))],
  ];
  for (const [what, lose] of losses) {
    const { capture, store, streams, recorders } = await setup();
    await capture.start(meeting);
    recorders[0].emit("a");
    lose(streams[0], recorders[0]);
    await until(() => capture.getSnapshot().status === "interrupted", what);
    const recording = capture.getSnapshot().recording!;
    assert.equal(recording.state, "paused", what);
    assert.deepEqual(await texts(await store.readParts(recording.id)), ["a."], what);
  }
});

test("a hidden page stores what is recorded so far; back with a working microphone it keeps recording, with an ended one it pauses", async () => {
  const { page, show } = fakePage();
  const { capture, streams, recorders, wakeLocks } = await setup({ page });
  await capture.start(meeting);

  show("hidden");
  assert.equal(recorders[0].flushes, 1, "the current chunk is stored before the page may be frozen");
  show("visible");
  await settle();
  assert.equal(capture.getSnapshot().status, "recording", "a laptop keeps recording in a background tab");
  assert.equal(wakeLocks.requested, 2, "the screen wake lock ends with a hidden page and is taken again");

  show("hidden");
  streams[0].track.readyState = "ended"; // ended while hidden, without an event reaching the page
  show("visible");
  await until(() => capture.getSnapshot().status === "interrupted", "the pause");
});

test("a tab that closes stores the chunk it has, also where the browser says so only with pagehide", async () => {
  const tab = new EventTarget();
  const { capture, recorders, store } = await setup({ window: tab });
  await capture.start(meeting);
  recorders[0].emit("a");
  // The browser hands over what it has recorded since the last chunk.
  recorders[0].requestData = () => recorders[0].emit("b");
  tab.dispatchEvent(new Event("pagehide"));
  const { id } = capture.getSnapshot().recording!;
  await until(async () => (await texts(await store.readParts(id)))[0] === "ab", "the last chunk stored");

  await capture.stop();
  recorders[0].requestData = () => assert.fail("a stopped recording has nothing to hand over");
  tab.dispatchEvent(new Event("pagehide"));
});

test("starting asks to keep the recording and the screen on; leaving the page leaves the recording paused for recovery", async () => {
  let persistRequests = 0;
  const store = await openRecordingStore({
    storage: {
      persist: async () => {
        persistRequests += 1;
        return true;
      },
      estimate: async () => ({ usage: 0, quota: 10 ** 12 }),
    },
  });
  const { capture, recorders, wakeLocks } = await setup({ store });
  await capture.start(meeting);
  assert.equal(persistRequests, 1);
  assert.equal(wakeLocks.requested, 1);
  assert.deepEqual(await store.listUnsent("user-1"), [], "a recording being captured is not offered for recovery");
  recorders[0].emit("a");

  capture.dispose();
  await until(async () => (await store.listUnsent("user-1")).length === 1, "the recording left for recovery");
  const [left] = await store.listUnsent("user-1");
  assert.equal(left.state, "paused");
  assert.deepEqual(await texts(await store.readParts(left.id)), ["a."]);
  assert.equal(wakeLocks.released, 1);
});

test("recordings are mono speech: one channel at 32 kbit/s, Opus where the browser has it, else its own format", async () => {
  const { capture, constraints, recorders } = await setup();
  await capture.start(meeting);
  await capture.stop();
  await capture.start({ ...meeting, mimeType: "audio/mp4" }); // Safari
  assert.deepEqual(constraints, [{ audio: { channelCount: 1 } }, { audio: { channelCount: 1 } }]);
  assert.deepEqual(
    recorders.map((recorder) => recorder.options),
    [
      { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 32_000 },
      { mimeType: "audio/mp4", audioBitsPerSecond: 32_000 },
    ],
  );
});

test("the recorded time leaves out pauses and interruptions, whatever the timers do", async () => {
  let now = 0;
  const { capture, streams, recorders } = await setup({ now: () => now });
  await capture.start(meeting);
  now = 2_000;
  recorders[0].emit("a");
  now = 3_000;
  capture.togglePause();
  now = 10_000; // seven paused seconds are not recorded
  capture.togglePause();
  now = 12_000;
  recorders[0].emit("b");
  now = 13_000;
  streams[0].track.lose("ended");
  await until(() => capture.getSnapshot().status === "interrupted", "the pause");
  now = 60_000; // the interruption is not recorded either
  await capture.continueRecording();
  now = 62_000;
  recorders[1].emit("c");
  const stopped = await capture.stop();

  assert.deepEqual(stopped?.parts.map((part) => part.durationMs), [6_000, 2_000]);
  assert.equal(stopped?.durationMs, 8_000);
  assert.equal(capture.elapsedMs(), 8_000);
});

// Two seconds at 32 kbit/s. A part of LIMIT bytes holds four such chunks and
// then needs a new part: the next chunk and the overlap, twice over, no longer fit.
const CHUNK = "x".repeat(8_000);
const LIMIT = 50_000;

test("a recording cut off by a reload records on at once in a new part of the same recording", async () => {
  const device = { indexedDB: new IDBFactory(), keyRange: IDBKeyRange, locks: fakeWebLocks() };
  let before = 0;
  const beforeReload = await setup({ store: await openRecordingStore(device), now: () => before });
  await beforeReload.capture.start(meeting);
  before = 2_000;
  beforeReload.recorders[0].emit("a");
  const { id } = beforeReload.capture.getSnapshot().recording!;
  await until(async () => (await beforeReload.store.get(id))?.parts[0]?.bytes === 1, "the chunk stored");
  // The phone kills the tab mid-meeting: no stop; the browser ends its lease.
  beforeReload.store.release(id);

  let now = 90_000; // the new page's own clock
  const store = await openRecordingStore(device);
  const { capture, constraints, recorders } = await setup({ store, now: () => now });
  await capture.adopt((await store.get(id))!); // as the unsent list shows it
  assert.equal(capture.getSnapshot().status, "recording", "the same surface as a new recording");
  assert.deepEqual(constraints, [{ audio: { channelCount: 1 } }]);
  assert.equal(capture.getSnapshot().recording?.id, id);
  assert.equal(capture.elapsedMs(), 2_000, "the time goes on from what was recorded");
  assert.deepEqual(await store.listUnsent("user-1"), [], "this tab holds it now");

  now = 91_000;
  recorders[0].emit("b");
  assert.equal(capture.elapsedMs(), 3_000);
  const stopped = await capture.stop();
  assert.equal(stopped?.id, id, "one recording, so one run");
  assert.equal(stopped?.durationMs, 3_000);
  assert.deepEqual(await texts(await store.readParts(id)), ["a", "b."], "the earlier part is unchanged");
});

test("a recording the person stopped, on a page since left, records on in a new part of the same recording", async () => {
  const device = { indexedDB: new IDBFactory(), keyRange: IDBKeyRange, locks: fakeWebLocks() };
  let before = 0;
  const first = await setup({ store: await openRecordingStore(device), now: () => before });
  await first.capture.start(meeting);
  before = 2_000;
  first.recorders[0].emit("a");
  const stoppedFirst = await first.capture.stop();
  assert.equal(stoppedFirst?.state, "stopped");
  // The person leaves the page (Alla flöden): the page lets the recording go, kept on the device.
  first.capture.dispose();

  let now = 90_000;
  const store = await openRecordingStore(device);
  const { capture, recorders } = await setup({ store, now: () => now });
  await capture.adopt(stoppedFirst!);
  assert.equal(capture.getSnapshot().status, "recording", "Fortsätt spela in, as for a recording a reload cut off");
  assert.equal(capture.getSnapshot().recording?.id, stoppedFirst!.id);
  assert.equal(capture.elapsedMs(), 2_000, "the time goes on from what was recorded");
  now = 91_000;
  recorders[0].emit("b");
  const stopped = await capture.stop();
  assert.equal(stopped?.id, stoppedFirst!.id, "one recording, so one run");
  assert.deepEqual(await texts(await store.readParts(stoppedFirst!.id)), ["a.", "b."], "the earlier part is unchanged");
});

test("only a recording no send has begun of, that no other tab holds, and that the flow takes another file for, can be continued", async () => {
  const device = { indexedDB: new IDBFactory(), keyRange: IDBKeyRange, locks: fakeWebLocks() };
  const otherTab = await openRecordingStore(device);
  const held = await otherTab.create(meeting);
  const finished = await otherTab.create(meeting);
  await otherTab.setState(finished.id, "uploading");
  otherTab.release(finished.id);
  const full = await otherTab.create(meeting);
  await otherTab.startPart(full.id);
  await otherTab.append(full.id, 0, new Blob(["a"]), 1_000);
  otherTab.release(full.id);

  // Each as the unsent list shows it.
  const [heldCopy, finishedCopy, fullCopy] = await Promise.all([held, finished, full].map(async ({ id }) => (await otherTab.get(id))!));
  const { capture, streams, requests } = await setup({ store: await openRecordingStore(device) });
  // What the page shows refuses it at once, with no microphone: a send of it has begun, or the flow takes no more files.
  await capture.adopt(finishedCopy);
  assert.equal(capture.getSnapshot().error, "Inspelningen är avslutad och kan inte fortsätta.");
  await capture.adopt(fullCopy, { maxBytes: LIMIT, maxFiles: 1 });
  assert.equal(capture.getSnapshot().status, "idle");
  assert.equal(
    capture.getSnapshot().error,
    "Flödet tar emot högst 1 fil, och inspelningen har redan så många delar.",
  );
  assert.equal(requests(), 0, "the microphone was never asked for");
  // Another tab holding it shows only under the lease: the microphone, asked for in the press, goes at once.
  await capture.adopt(heldCopy);
  assert.equal(capture.getSnapshot().status, "idle");
  assert.equal(capture.getSnapshot().error, "Inspelningen används i en annan flik.");
  assert.ok(streams.every((stream) => stream.track.readyState === "ended"), "and let go at once");

  // Reading it fails after the lease was taken: the lease is let go again.
  const reopened = await openRecordingStore(device);
  const get = IDBObjectStore.prototype.get;
  let reads = 0;
  IDBObjectStore.prototype.get = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["get"]>) {
    reads += 1;
    if (reads > 1) throw new DOMException("Connection to Indexed Database server lost", "UnknownError");
    return get.apply(this, args);
  };
  const unreadable = await setup({ store: reopened });
  try {
    otherTab.release(held.id);
    await settle();
    await unreadable.capture.adopt(heldCopy);
  } finally {
    IDBObjectStore.prototype.get = get;
  }
  assert.equal(unreadable.capture.getSnapshot().error, "Inspelningen kunde inte öppnas.");
  assert.equal(await reopened.lease(held.id), true, "nobody holds it");
  reopened.release(held.id);

  // A page that goes away while it opens one leaves it for recovery.
  await settle();
  const leaving = await setup({ store: await openRecordingStore(device) });
  const adopting = leaving.capture.adopt(heldCopy);
  leaving.capture.dispose();
  await adopting;
  await settle();
  assert.equal(leaving.capture.getSnapshot().status, "idle");
  assert.deepEqual(
    (await leaving.store.listUnsent("user-1")).map((r) => r.id).sort(),
    [held.id, finished.id, full.id].sort(),
    "all are still unsent, and no tab holds any",
  );
  assert.ok(leaving.streams.every((stream) => stream.track.readyState === "ended"));
});

/** The ready state after Stoppa: a recording made and stopped in this tab. */
async function stoppedCapture(options: Parameters<typeof setup>[0] = {}) {
  const made = await setup(options);
  await made.capture.start(meeting, { maxBytes: LIMIT, maxFiles: 3 });
  made.recorders[0].emit("a");
  const stopped = (await made.capture.stop())!;
  return { ...made, stopped };
}

const SEND_BEGUN = "Inspelningen skickas eller har redan skickats och kan inte fortsätta.";
const GONE = "Inspelningen finns inte längre på enheten.";

test("'Fortsätt spela in' asks for the microphone in the press itself, as Starta does, not once the device's storage has answered", async () => {
  // WebKit lets only a request made in the user's gesture use the page's earlier answer: one made later, after the
  // storage has answered, is asked again after a minute without recording, and refused without asking once refused.
  const limits = { maxBytes: LIMIT, maxFiles: 3 };
  const { capture, store, requests, stopped, recorders } = await stoppedCapture();
  const continuing = capture.continueStopped(stopped, limits);
  assert.equal(requests(), 2, "asked in the same task as the press");
  await continuing;
  assert.equal(capture.getSnapshot().status, "recording");
  assert.equal(recorders.length, 2, "a new part");

  // A cut-off recording from the unsent list, the same.
  capture.dispose();
  await until(async () => (await store.get(stopped.id))?.state === "paused", "kept for recovery");
  const id = stopped.id;
  const reopened = await setup({ store });
  const adopting = reopened.capture.adopt((await reopened.store.get(id))!, limits);
  assert.equal(reopened.requests(), 1, "asked in the same task as the press");
  await adopting;
  assert.equal(reopened.capture.getSnapshot().status, "recording");
});

test("after Stoppa, 'Fortsätt spela in' records on in a new part of the same recording", async () => {
  let now = 0;
  const { capture, store, recorders } = await setup({ now: () => now });
  const limits = { maxBytes: LIMIT, maxFiles: 2 };
  await capture.start(meeting, limits);
  now = 2_000;
  recorders[0].emit("a");
  const stopped = (await capture.stop())!;

  await capture.continueStopped(stopped, limits);
  assert.equal(capture.getSnapshot().status, "recording");
  assert.equal(capture.elapsedMs(), 2_000, "the time goes on from what was recorded");
  assert.equal(capture.timeLeftMs(), 8_350, "in the last file the flow takes");
  now = 3_000;
  recorders[1].emit("b");
  const again = (await capture.stop())!;
  assert.equal(again.id, stopped.id, "one recording, so one run");
  assert.equal(again.durationMs, 3_000);
  assert.deepEqual(await texts(await store.readParts(again.id)), ["a.", "b."], "the earlier part as it was");
});

test("a stopped recording is not continued once a send of it has begun, and stays ready to send", async () => {
  const limits = { maxBytes: LIMIT, maxFiles: 3 };
  const { capture, store, streams, stopped } = await stoppedCapture();
  let finishUpload = () => {};
  const sending = submitRecording(
    store,
    stopped.id,
    {
      flowId: "flow-1",
      contract: { flow_id: "flow-1", published_flow_version: 1 },
      stepId: "step-audio",
      inputPayload: {},
      online: createOnlineStatus(),
    },
    {
      upload: () => new Promise((resolve) => (finishUpload = () => resolve({ id: "file-a" }))),
      startRun: async () => ({ id: "run-1", flow_id: "flow-1", status: "queued" }),
    },
  );
  // The page shows the send as the device has it.
  await until(() => capture.getSnapshot().recording?.state === "uploading", "the send");
  await capture.continueStopped(capture.getSnapshot().recording!, limits);
  const refused = capture.getSnapshot();
  assert.deepEqual([refused.status, refused.recording?.id, refused.error], ["stopped", stopped.id, SEND_BEGUN]);
  assert.equal(streams.length, 1, "no microphone opened");

  // Sent while the page still showed it stopped: the device's word, and the microphone asked for in the press goes at once.
  finishUpload();
  await sending;
  await capture.continueStopped(stopped, limits);
  assert.equal(capture.getSnapshot().error, GONE, "sent, and its copy deleted");
  assert.ok(streams.every((stream) => stream.track.readyState === "ended"));

  // A send whose tab died while Eneo made the run, and a sent one whose copy could not be deleted.
  for (const state of ["uploaded", "submitted"] as const) {
    const left = await stoppedCapture();
    await left.store.setState(left.stopped.id, state);
    await until(() => left.capture.getSnapshot().recording?.state === state, state);
    await left.capture.continueStopped(left.capture.getSnapshot().recording!, limits);
    assert.equal(left.capture.getSnapshot().error, SEND_BEGUN, state);
    assert.equal(left.streams.length, 1, state);
  }
});

test("a stopped recording is not continued while another tab holds it, once it is deleted, past the flow's file count or without a microphone", async () => {
  const device = { indexedDB: new IDBFactory(), keyRange: IDBKeyRange, locks: fakeWebLocks() };
  const limits = { maxBytes: LIMIT, maxFiles: 3 };
  const { capture, store, streams, stopped } = await stoppedCapture({ store: await openRecordingStore(device) });
  const otherTab = await openRecordingStore(device);
  // This tab's page has let the recording go (it is no longer on its screen), and another tab sends it.
  store.letGo(stopped.id);
  for (let i = 0; i < 5; i += 1) await settle();
  assert.equal(await otherTab.lease(stopped.id), true);
  await capture.continueStopped(stopped, limits);
  assert.deepEqual(
    [capture.getSnapshot().status, capture.getSnapshot().error],
    ["stopped", "Inspelningen används i en annan flik."],
  );
  otherTab.release(stopped.id);

  // Deleted in the other tab between this tab's look and its lease: nothing is recorded into it.
  const lease = store.lease.bind(store);
  store.lease = async (id) => {
    await otherTab.remove(id);
    return lease(id);
  };
  await capture.continueStopped(stopped, limits);
  assert.equal(capture.getSnapshot().error, GONE);
  // Neither shows on the page before the lease: the microphone, asked for in the press, is let go at once.
  assert.ok(streams.every((stream) => stream.track.readyState === "ended"), "the microphone let go");

  const full = await stoppedCapture();
  await full.capture.continueStopped(full.stopped, { maxBytes: LIMIT, maxFiles: 1 });
  assert.equal(
    full.capture.getSnapshot().error,
    "Flödet tar emot högst 1 fil, och inspelningen har redan så många delar.",
  );
  assert.equal(full.requests(), 1, "known from the page: no microphone asked for");

  const microphone = { denied: false };
  const denied = await stoppedCapture({ microphone });
  microphone.denied = true;
  await denied.capture.continueStopped(denied.stopped, limits);
  assert.deepEqual(
    [denied.capture.getSnapshot().status, denied.capture.getSnapshot().error],
    ["stopped", "Tillåt mikrofonen i webbläsaren för att spela in."],
  );
  assert.equal(await denied.store.lease(denied.stopped.id), true, "its lease let go");

  // A microphone another app holds (Teams in a meeting room) says what to do, as the setup's start does.
  const taken: { refusal?: string } = {};
  const inUse = await stoppedCapture({ microphone: taken });
  taken.refusal = "NotReadableError";
  await inUse.capture.continueStopped(inUse.stopped, limits);
  assert.equal(inUse.capture.getSnapshot().error, "Mikrofonen kunde inte startas. Stäng andra appar som använder mikrofonen och försök igen.");
});

test("Stoppa while 'Fortsätt spela in' waits for the microphone starts no recorder afterwards", async () => {
  const microphone: { wait?: Promise<void> } = {};
  const { capture, store, streams, recorders } = await setup({ microphone });
  await capture.start(meeting);
  recorders[0].emit("a");
  streams[0].track.lose("ended");
  await until(() => capture.getSnapshot().status === "interrupted", "the pause");

  let grant = () => {};
  microphone.wait = new Promise((resolve) => (grant = resolve));
  const continuing = capture.continueRecording();
  const stopped = await capture.stop();
  grant();
  await continuing;

  assert.equal(recorders.length, 1, "no recorder after Stoppa");
  await until(() => streams[1]?.track.readyState === "ended", "the cancelled microphone request releases its late stream");
  assert.equal(streams[1].track.readyState, "ended", "the late microphone is let go");
  assert.equal(capture.getSnapshot().status, "stopped");
  assert.equal(await store.lease(stopped!.id), true, "nothing holds the recording");
  assert.deepEqual(await texts(await store.readParts(stopped!.id)), ["a."]);
});

test("a page left while the store opens starts no recorder and leaves no recording", async () => {
  // A shared device store without Web Locks, where only the lease holder may delete a live-looking recording.
  const store = await openRecordingStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange });
  const stream = new FakeStream();
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  let recorders = 0;
  const capture = new RecordingCapture(
    async () => {
      await opened;
      return store;
    },
    {
      getStream: async () => stream as unknown as MediaStream,
      createRecorder: () => {
        recorders += 1;
        return new FakeRecorder(stream, { mimeType: "audio/webm" }) as unknown as MediaRecorder;
      },
    },
  );
  const starting = capture.start(meeting);
  await settle(); // the microphone is granted; the store is still opening
  capture.dispose();
  assert.equal(stream.track.readyState, "ended", "the microphone is let go before the store has opened");
  open();
  await starting;

  assert.equal(recorders, 0);
  assert.equal(stream.track.readyState, "ended");
  assert.deepEqual(await store.listUnsent("user-1"), []);

  // Nor does taking over a stopped recording when the page goes while the space is checked.
  let estimate = () => {};
  const estimated = new Promise<void>((resolve) => (estimate = resolve));
  const slow = await openRecordingStore({
    storage: {
      persist: async () => true,
      estimate: async () => {
        await estimated;
        return { usage: 0, quota: 10 ** 12 };
      },
    },
  });
  const made = await slow.create(meeting);
  await slow.startPart(made.id);
  await slow.append(made.id, 0, new Blob(["a"]), 1_000);
  await slow.setState(made.id, "stopped");
  slow.release(made.id);
  const second = new FakeStream();
  let asked = false;
  const later = new RecordingCapture(() => slow, {
    getStream: async () => {
      asked = true;
      return second as unknown as MediaStream;
    },
    createRecorder: () => {
      recorders += 1;
      return new FakeRecorder(second, { mimeType: "audio/webm" }) as unknown as MediaRecorder;
    },
  });
  const continuing = later.continueStopped(made);
  await until(() => asked, "the microphone asked for");
  later.dispose();
  assert.equal(second.track.readyState, "ended", "the microphone is let go before the space is checked");
  estimate();
  await continuing;
  assert.equal(recorders, 0);
  assert.equal(second.track.readyState, "ended");
  assert.equal(await slow.lease(made.id), true, "nothing holds the recording");
});

test("a page left while 'Fortsätt spela in' waits for the device's lease and the microphone lets both go", async () => {
  const microphone: { wait?: Promise<void> } = {};
  const { capture, store, streams, recorders, requests, stopped } = await stoppedCapture({ microphone });
  // The microphone is asked for in the press, and the browser still asks; the lease comes meanwhile.
  let grant = () => {};
  microphone.wait = new Promise((resolve) => (grant = resolve));
  let lease = () => {};
  const leased = new Promise<void>((resolve) => (lease = resolve));
  const take = store.lease.bind(store);
  store.lease = async (id) => {
    await leased;
    return take(id);
  };
  const continuing = capture.continueStopped(stopped, { maxBytes: LIMIT, maxFiles: 3 });
  assert.equal(requests(), 2);
  capture.dispose();
  lease();
  await continuing;
  grant();
  await until(() => streams.length === 2, "the browser's late answer");
  assert.equal(streams[1].track.readyState, "ended", "the microphone let go");
  assert.equal(recorders.length, 1, "no new part");
  store.lease = take;
  store.letGo(stopped.id); // the page has gone
  await settle();
  assert.equal(await store.lease(stopped.id), true, "nothing holds the recording");
});

/** Holds one store call pending until the returned function runs: the device's storage being slow, or never answering. */
function slowStore<Name extends "create" | "lowOnSpace" | "setState" | "append">(store: RecordingStore, method: Name) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const original = store[method].bind(store) as (...args: unknown[]) => Promise<unknown>;
  (store as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
    await gate;
    return original(...args);
  };
  return release;
}

test("leaving during start-up lets the microphone go at once, whatever the device's storage is doing", async () => {
  for (const stalled of ["opening", "create", "lowOnSpace"] as const) {
    const store = await openRecordingStore({});
    let open = () => {};
    const opening = new Promise<void>((resolve) => (open = resolve));
    const release = stalled === "opening" ? open : stalled === "create" ? slowStore(store, "create") : slowStore(store, "lowOnSpace");
    const stream = new FakeStream();
    let recorders = 0;
    const capture = new RecordingCapture(
      async () => {
        if (stalled === "opening") await opening;
        return store;
      },
      {
        getStream: async () => stream as unknown as MediaStream,
        createRecorder: () => {
          recorders += 1;
          return new FakeRecorder(stream, { mimeType: "audio/webm" }) as unknown as MediaRecorder;
        },
      },
    );
    const starting = capture.start(meeting);
    await settle();
    await settle(); // the microphone is granted; the storage is the thing that is pending
    assert.equal(stream.track.readyState, "live", `${stalled}: the microphone is on while it starts`);

    capture.dispose();
    assert.equal(stream.track.readyState, "ended", `${stalled}: leaving lets the microphone go before the storage has answered`);

    release();
    await starting;
    assert.equal(recorders, 0, `${stalled}: no recorder starts afterwards`);
    assert.deepEqual(await store.listUnsent("user-1"), [], `${stalled}: and no empty recording is left`);
  }
});

test("Stoppa during start-up lets the microphone go at once too", async () => {
  const store = await openRecordingStore({});
  const release = slowStore(store, "lowOnSpace");
  const { capture, streams, recorders } = await setup({ store });
  const starting = capture.start(meeting);
  await until(() => streams.length === 1, "the microphone granted");
  await settle();
  await capture.stop();
  assert.equal(streams[0].track.readyState, "ended", "the microphone is let go while the storage is pending");
  release();
  await starting;
  assert.equal(recorders.length, 0);
  assert.deepEqual(await store.listUnsent("user-1"), []);
});

test("Stoppa lets the microphone go without waiting for the database, and the last chunk still lands", async () => {
  const { capture, store, streams, recorders } = await setup();
  await capture.start(meeting);
  recorders[0].emit("a");
  const release = slowStore(store, "setState");
  const stopping = capture.stop();
  await settle();
  await settle();
  assert.equal(streams[0].track.readyState, "ended", "the hardware is released while the storage is still pending");
  assert.equal(await capture.stop(), null, "a second Stoppa while it is stored does nothing");
  release();
  const stopped = await stopping;
  assert.equal(stopped?.state, "stopped");
  assert.deepEqual(await texts(await store.readParts(stopped!.id)), ["a."], "the recorder's last data is kept");
});

test("Stoppa on a recording that has vanished from the device still ends: the microphone goes, and the page is not left recording", async () => {
  const { capture, store, streams, recorders } = await setup();
  await capture.start(meeting);
  recorders[0].emit("a");
  const { id } = capture.getSnapshot().recording!;
  await store.discard(id); // deleted by this tab itself: nothing of it is left to keep
  const stopped = await capture.stop();
  assert.equal(stopped, null);
  assert.equal(streams[0].track.readyState, "ended");
  const { status, stopping, error } = capture.getSnapshot();
  assert.equal(status, "stopped", "not left recording");
  assert.equal(stopping, false);
  assert.equal(error, NOT_ON_DEVICE, "and it says why");
});

test("Stoppa when the device cannot say the recording is stopped ends too, and says so", async () => {
  const { capture, store, streams, recorders } = await setup();
  await capture.start(meeting);
  recorders[0].emit("a");
  store.setState = () => Promise.reject(new DOMException("The database connection is closing.", "InvalidStateError"));
  assert.equal(await capture.stop(), null);
  assert.equal(streams[0].track.readyState, "ended");
  const { status, stopping, error } = capture.getSnapshot();
  assert.deepEqual([status, stopping], ["stopped", false]);
  assert.equal(error, "Inspelningen stoppades, men det gick inte att bekräfta att den sparades på enheten.");
});

test("a microphone lost while the device cannot confirm the pause leaves the recording interrupted, says so, and Stoppa still ends", async () => {
  const { capture, store, streams, recorders } = await setup();
  await capture.start(meeting);
  recorders[0].emit("a");
  store.setState = () => Promise.reject(new DOMException("The database connection is closing.", "InvalidStateError"));
  streams[0].track.lose("ended");
  await until(() => capture.getSnapshot().status === "interrupted", "the recording interrupted");
  const { stream, error } = capture.getSnapshot();
  assert.equal(stream, null);
  // Said under the pause's own warning, which names the pause (recordingNotices).
  assert.equal(error, "Det gick inte att bekräfta att inspelningen sparades på enheten.");
  assert.equal(await capture.stop(), null);
  assert.equal(capture.getSnapshot().status, "stopped");
});

test("a microphone lost after the recording vanished from the device leaves the recording interrupted and says it is gone", async () => {
  const { capture, store, streams, recorders } = await setup();
  await capture.start(meeting);
  recorders[0].emit("a");
  await store.discard(capture.getSnapshot().recording!.id);
  streams[0].track.lose("ended");
  await until(() => capture.getSnapshot().status === "interrupted", "the recording interrupted");
  assert.equal(capture.getSnapshot().error, NOT_ON_DEVICE);
});

test("leaving a running recording when the device cannot keep it paused ends quietly", async () => {
  const { capture, store, streams, recorders } = await setup();
  await capture.start(meeting);
  recorders[0].emit("a");
  store.setState = () => Promise.reject(new DOMException("The database connection is closing.", "InvalidStateError"));
  capture.dispose();
  for (let i = 0; i < 5; i += 1) await settle();
  assert.equal(streams[0].track.readyState, "ended");
});

test("chunks that no longer reach the device are said at once, while the recording goes on", async () => {
  const { capture, store, recorders } = await setup();
  await capture.start(meeting);
  recorders[0].emit("a");
  await store.discard(capture.getSnapshot().recording!.id); // deleted by this tab itself: nothing of it is left to keep
  recorders[0].emit("b");
  await until(() => capture.getSnapshot().error === NOT_ON_DEVICE, "the loss said");
  assert.equal(capture.getSnapshot().status, "recording");
});

/** A device whose storage the browser can clear under an open recording: the next connection is to an empty database. */
function wipeable() {
  let underneath = new IDBFactory();
  const connections: IDBDatabase[] = [];
  const factory = {
    open(name: string, version?: number) {
      const request = underneath.open(name, version);
      request.addEventListener("success", () => connections.push(request.result));
      return request;
    },
  } as unknown as IDBFactory;
  return {
    env: { indexedDB: factory, keyRange: IDBKeyRange, locks: fakeWebLocks() },
    wipe() {
      connections.splice(0).forEach((connection) => connection.close());
      underneath = new IDBFactory();
    },
  };
}

test("the device cleared in the middle of a recording is said at once, the recording goes on, and Stoppa leaves what is kept to save and send", async () => {
  const { env, wipe } = wipeable();
  const store = await openRecordingStore(env);
  const { capture, recorders } = await setup({ store });
  await capture.start(meeting);
  const { id } = capture.getSnapshot().recording!;
  recorders[0].emit("H");
  recorders[0].emit("a");
  await until(async () => (await store.get(id))?.parts[0]?.chunks === 2, "both chunks kept");

  wipe();
  recorders[0].emit("b");
  await until(() => capture.getSnapshot().refused === "lost", "the loss said");
  const { status, error, persistent } = capture.getSnapshot();
  assert.deepEqual([status, error, persistent], ["recording", null, false], "it goes on, with no failure to stop it");

  recorders[0].emit("c");
  const stopped = await capture.stop();
  assert.equal(stopped?.state, "stopped");
  assert.deepEqual(await texts(await store.readParts(id)), ["Hbc."], "the header and what came after");
  assert.deepEqual(await texts(await store.readPartsToSend(id)), ["Hbc."]);
});

test("a stopped recording stays this page's while it is shown: another tab neither offers nor deletes it, until Spela in på nytt or the page goes", async () => {
  const device = { indexedDB: new IDBFactory(), keyRange: IDBKeyRange, locks: fakeWebLocks() };
  const store = await openRecordingStore(device);
  const otherTab = await openRecordingStore(device);
  const ids = async () => (await otherTab.listUnsent("user-1")).map((r) => r.id);

  const first = await setup({ store });
  await first.capture.start(meeting);
  first.recorders[0].emit("a");
  const stopped = await first.capture.stop();
  for (let i = 0; i < 5; i += 1) await settle();
  assert.deepEqual(await ids(), [], "the recording is on the first tab's screen");
  await assert.rejects(otherTab.remove(stopped!.id), { message: "Inspelningen används i en annan flik." });

  first.capture.reset(); // Spela in på nytt
  for (let i = 0; i < 5; i += 1) await settle();
  assert.deepEqual(await ids(), [stopped!.id], "offered once the page shows it no more");

  const second = await setup({ store });
  await second.capture.start(meeting);
  second.recorders[0].emit("b");
  const again = await second.capture.stop();
  for (let i = 0; i < 5; i += 1) await settle();
  assert.deepEqual(await ids(), [stopped!.id], "the new one is held; the old one is the other's");
  second.capture.dispose(); // the page goes away
  for (let i = 0; i < 5; i += 1) await settle();
  assert.deepEqual((await ids()).sort(), [stopped!.id, again!.id].sort());
});

test("Stoppa while the screen's wake lock is still being asked for leaves the recording stopped on the device, not paused", async () => {
  let grant = () => {};
  const wakeLock = new Promise<void>((resolve) => (grant = resolve));
  const { capture, store, recorders } = await setup({ wakeLock });
  const starting = capture.start(meeting);
  await until(() => capture.getSnapshot().status === "recording", "recording");
  recorders[0].emit("a");
  const { id } = capture.getSnapshot().recording!;
  const stopping = capture.stop();
  grant();
  await Promise.all([starting, stopping]);
  for (let i = 0; i < 5; i += 1) await settle();
  assert.equal((await store.get(id))?.state, "stopped");
});

test("leaving a running recording lets the microphone go without waiting for the database, and keeps what was recorded", async () => {
  const { capture, store, streams, recorders } = await setup();
  await capture.start(meeting);
  recorders[0].emit("a");
  const id = capture.getSnapshot().recording!.id;
  const release = slowStore(store, "setState");
  capture.dispose();
  await settle();
  assert.equal(streams[0].track.readyState, "ended", "the hardware is released while the storage is still pending");
  release();
  await until(async () => (await store.get(id))?.state === "paused", "the recording kept, paused");
  assert.deepEqual(await texts(await store.readParts(id)), ["a."]);
});

test("without Web Locks, another tab cannot send a stopped recording while its own tab continues it", async () => {
  const device = { indexedDB: new IDBFactory(), keyRange: IDBKeyRange }; // no Web Locks
  const microphone: { wait?: Promise<void> } = {};
  const { capture, store, recorders } = await setup({ store: await openRecordingStore(device), microphone });
  await capture.start(meeting);
  recorders[0].emit("a");
  const stopped = (await capture.stop())!;

  let grant = () => {};
  microphone.wait = new Promise((resolve) => (grant = resolve));
  const continuing = capture.continueStopped(stopped); // waits for the microphone
  const otherTab = await openRecordingStore(device);
  let asked = 0;
  await assert.rejects(
    submitRecording(
      otherTab,
      stopped.id,
      {
        flowId: "flow-1",
        contract: { flow_id: "flow-1", published_flow_version: 1 },
        stepId: "step-audio",
        inputPayload: {},
        online: createOnlineStatus(),
      },
      {
        upload: async () => ({ id: "file-a" }),
        startRun: async () => {
          asked += 1;
          return { id: "run-1", flow_id: "flow-1", status: "queued" };
        },
      },
    ),
    { message: "Inspelningen används i en annan flik." },
  );
  grant();
  await continuing;
  recorders[1].emit("b");
  const again = (await capture.stop())!;
  assert.equal(asked, 0, "Eneo was never asked");
  assert.deepEqual(await texts(await store.readParts(again.id)), ["a.", "b."], "both parts stay");
});

test("a page left while the browser asks for the microphone records nothing and lets the microphone go", async () => {
  const store = await openRecordingStore({});
  const stream = new FakeStream();
  let grant = (_stream: MediaStream) => {};
  let recorders = 0;
  const capture = new RecordingCapture(() => store, {
    getStream: () => new Promise((resolve) => (grant = resolve)),
    createRecorder: () => {
      recorders += 1;
      return new FakeRecorder(stream, { mimeType: "audio/webm" }) as unknown as MediaRecorder;
    },
  });
  const starting = capture.start(meeting);
  capture.dispose(); // the user navigates away with the permission prompt open
  grant(stream as unknown as MediaStream);
  await starting;

  assert.equal(recorders, 0);
  assert.equal(stream.track.readyState, "ended");
  assert.equal(capture.getSnapshot().status, "idle");
  assert.deepEqual(await store.listUnsent("user-1"), []);
});

test("before a part is too large to send, a new part starts, and the two overlap by 150 ms", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  const { capture, store, streams, recorders } = await setup({ now: () => now });
  await capture.start(meeting, { maxBytes: LIMIT, maxFiles: 3 });
  for (let i = 0; i < 4; i += 1) recorders[0].emit(CHUNK);
  assert.equal(recorders.length, 1, "room for the next chunk and the overlap");
  now = 10_000;
  recorders[0].emit(CHUNK);
  assert.equal(recorders.length, 2, "the next part starts at once");
  assert.equal(recorders[1].state, "recording");
  assert.equal(recorders[0].state, "recording", "while the full part still records");
  assert.equal(capture.elapsedMs(), 10_000, "the recorded time goes on across parts");
  t.mock.timers.tick(149);
  assert.equal(recorders[0].state, "recording");
  now = 10_150;
  t.mock.timers.tick(1);
  assert.equal(recorders[0].state, "inactive", "until 150 ms later");
  await settle(); // its last chunk
  assert.equal(capture.elapsedMs(), 10_150, "the overlap counts once");
  assert.equal(capture.timeLeftMs(), 16_700, "the new part and one more");
  assert.equal(streams.length, 1, "the same microphone: no new permission");
  assert.equal(streams[0].track.readyState, "live");
  assert.equal(capture.getSnapshot().status, "recording");
  assert.equal(capture.getSnapshot().error, null);

  recorders[1].emit("new");
  const stopped = await capture.stop();
  const files = await store.readParts(stopped!.id);
  assert.deepEqual(
    files.map((file) => [file.index, file.blob.size]),
    [
      [0, 5 * 8_000 + 1],
      [1, 3 + 1],
    ],
    "in capture order, each small enough to send",
  );
  assert.ok(files[0].blob.size <= LIMIT);
});

test("a full part that fails during its overlap leaves the new part recording", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { capture, store, recorders } = await setup();
  await capture.start(meeting, { maxBytes: LIMIT });
  for (let i = 0; i < 5; i += 1) recorders[0].emit(CHUNK);
  recorders[0].dispatchEvent(new Event("error"));
  await settle();
  assert.deepEqual(recorders.map((recorder) => recorder.state), ["inactive", "recording"]);
  assert.equal(capture.getSnapshot().status, "recording");
  t.mock.timers.tick(150);

  recorders[1].emit("new");
  const stopped = await capture.stop();
  assert.deepEqual((await store.readParts(stopped!.id)).map((file) => file.blob.size), [5 * 8_000 + 1, 3 + 1]);
});

test("a part that fills while the one before still overlaps ends that overlap first", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { capture, recorders } = await setup();
  await capture.start(meeting, { maxBytes: LIMIT });
  for (let i = 0; i < 5; i += 1) recorders[0].emit(CHUNK);
  for (let i = 0; i < 5; i += 1) recorders[1].emit(CHUNK);
  assert.deepEqual(recorders.map((recorder) => recorder.state), ["inactive", "recording", "recording"]);
});

test("the room left in a part follows the recording's rate: a faster encoder starts the next part sooner", async () => {
  // 10 000 B per 2 s chunk is 5 B/ms: after three chunks, the next one and the
  // overlap, twice over, no longer fit in LIMIT (at 4 B/ms they still would).
  const { capture, recorders } = await setup();
  await capture.start(meeting, { maxBytes: LIMIT });
  recorders[0].emit("x".repeat(10_000));
  recorders[0].emit("x".repeat(10_000));
  assert.equal(recorders.length, 1);
  recorders[0].emit("x".repeat(10_000));
  assert.equal(recorders.length, 2);
});

test("the recorder tells how much recording time the flow still takes", async () => {
  const unbounded = await setup();
  await unbounded.capture.start(meeting, { maxBytes: LIMIT });
  assert.equal(unbounded.capture.timeLeftMs(), null, "no file count, no end");

  const { capture, recorders } = await setup();
  await capture.start(meeting, { maxBytes: LIMIT, maxFiles: 2 });
  // Each part holds 50 000 − 16 600 B before the next starts: 8 350 ms at 32 kbit/s.
  assert.equal(capture.timeLeftMs(), 16_700);
  recorders[0].emit(CHUNK);
  assert.equal(capture.timeLeftMs(), 14_700);

  let now = 0;
  const timed = await setup({ now: () => now });
  await timed.capture.start(meeting, { maxDurationMs: 5 * 3_600_000, maxFiles: 1 });
  assert.equal(timed.capture.timeLeftMs(), 5 * 3_600_000 - 60_000, "a time limit alone ends it too");
});

test("the snapshot carries the time left as the tier the page tells of, and says nothing while the tier stands", async () => {
  const MINUTE = 60_000;
  let now = 0;
  const { capture, recorders } = await setup({ now: () => now });
  // 21 minutes less the minute of room: 20 minutes of recording.
  await capture.start(meeting, { maxRecordingMs: 21 * MINUTE });
  let told = 0;
  capture.subscribe(() => (told += 1));
  const noticesAt = (remainingMs: number | null) =>
    recordingNotices({ phase: "recording", silent: false, lowSpace: false, persistent: true, refused: null, remainingMs, muted: false, wakeLock: true });

  // Around every boundary the page tells exactly what it would from the exact time left.
  for (const left of [20 * MINUTE, 15 * MINUTE + 1, 15 * MINUTE, 15 * MINUTE - 1, 5 * MINUTE + 1, 5 * MINUTE, 5 * MINUTE - 1, 1]) {
    now = 20 * MINUTE - left;
    recorders[0].emit("x");
    assert.equal(capture.timeLeftMs(), left);
    assert.deepEqual(noticesAt(capture.getSnapshot().remainingMs), noticesAt(left), `${left} ms left`);
  }
  assert.equal(capture.getSnapshot().remainingMs, 5 * MINUTE);

  // Chunks inside a tier tell nobody.
  now = 20 * MINUTE - 4 * MINUTE;
  recorders[0].emit("x");
  const settled = told;
  for (let at = 4 * MINUTE; at > 2 * MINUTE; at -= 2_000) {
    now = 20 * MINUTE - at;
    recorders[0].emit("x");
  }
  assert.equal(told, settled, "30 s ago and now are both 'under five minutes'");

  // The limit still stops the recording the moment the exact time is gone.
  now = 20 * MINUTE - 1;
  recorders[0].emit("x");
  assert.equal(capture.getSnapshot().limitReached, false);
  now = 20 * MINUTE;
  recorders[0].emit("x");
  assert.equal(capture.getSnapshot().limitReached, true);
  assert.equal(capture.getSnapshot().remainingMs, 0);
  await until(() => capture.getSnapshot().status === "stopped", "the stop at the end");
});

test("a patch that changes nothing does not notify", async () => {
  const { capture, recorders } = await setup();
  await capture.start(meeting, { maxBytes: LIMIT });
  let told = 0;
  capture.subscribe(() => (told += 1));
  recorders[0].emit("x");
  recorders[0].emit("x");
  assert.equal(told, 0, "no end, so the chunks leave the snapshot as it was");
});

test("when the flow's last file is full the recording stops with that reason and keeps everything", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { capture, store, streams, recorders } = await setup();
  await capture.start(meeting, { maxBytes: LIMIT, maxFiles: 2 });
  for (let i = 0; i < 5; i += 1) recorders[0].emit(CHUNK);
  t.mock.timers.tick(150);
  for (let i = 0; i < 5; i += 1) recorders[1].emit(CHUNK); // the second file, the last the flow takes
  await until(() => capture.getSnapshot().status === "stopped", "the stop");

  const snapshot = capture.getSnapshot();
  assert.equal(snapshot.limitReached, true);
  assert.equal(snapshot.remainingMs, 0);
  assert.equal(
    snapshot.error,
    "Inspelningen stoppades vid flödets gräns på 2 filer om 48,8\u00a0kB. Det som spelats in är sparat.",
  );
  assert.equal(recorders.length, 2, "no third part");
  const files = await store.readParts(snapshot.recording!.id);
  assert.equal(files.length, 2);
  assert.ok(files.every((file) => file.blob.size <= LIMIT));
  assert.equal(streams[0].track.readyState, "ended");

  const single = await setup();
  await single.capture.start(meeting, { maxBytes: LIMIT, maxFiles: 1 });
  for (let i = 0; i < 5; i += 1) single.recorders[0].emit(CHUNK);
  await until(() => single.capture.getSnapshot().status === "stopped", "the stop at one file");
  assert.equal(
    single.capture.getSnapshot().error,
    "Inspelningen stoppades vid flödets gräns på 48,8\u00a0kB. Det som spelats in är sparat.",
  );
});

const HOUR = 3_600_000;
// Eneo's flow_audio_max_duration_seconds, per decoded file, as the run contract gives it.
const FIVE_HOURS = 5 * HOUR;

test("a part hands over before Eneo's time per file, in recorded time without pauses, whatever the encoder's rate", async () => {
  let now = 0;
  const { capture, recorders } = await setup({ now: () => now });
  await capture.start(meeting, { maxDurationMs: FIVE_HOURS, maxBytes: 10 ** 12, maxFiles: 2 });
  now = 2 * HOUR;
  // Far above the 32 kbit/s target, and still far below the byte limit: only the time decides.
  recorders[0].emit("x".repeat(100_000));
  capture.togglePause();
  now = 3 * HOUR; // an hour's break is not recorded time
  capture.togglePause();
  now = 6 * HOUR - 61_000;
  recorders[0].emit("x");
  assert.equal(recorders.length, 1, "4:58:59 recorded");
  assert.equal(capture.timeLeftMs(), 1_000 + (5 * HOUR - 60_000), "this part's last second, and one more file");
  now = 6 * HOUR - 60_000;
  recorders[0].emit("x");
  assert.equal(recorders.length, 2, "at 4:59 a new part takes over: the last minute is room for the final chunk and the overlap");
  assert.equal(recorders[1].state, "recording");
});

// Eneo's longest recording (the admin's value), for the parts of one recording together, and the part length at
// which its ten file slots hold it (recording_part_seconds).
const ONE_RECORDING = { maxDurationMs: FIVE_HOURS, maxBytes: 10 ** 12, maxFiles: 10, partMs: 30 * 60_000, maxRecordingMs: FIVE_HOURS };

test("parts turn over at Eneo's part length, and the recording stops before Eneo's longest recording, over all parts", async () => {
  let now = 0;
  const { capture, recorders } = await setup({ now: () => now });
  await capture.start(meeting, ONE_RECORDING);
  // The room: a minute, and a second for each handover's overlap.
  assert.equal(capture.timeLeftMs(), FIVE_HOURS - 60_000, "the recording's end, not ten times five hours");
  now = 30 * 60_000 - 1;
  recorders.at(-1)!.emit("x");
  assert.equal(recorders.length, 1);
  now = 30 * 60_000;
  recorders.at(-1)!.emit("x");
  assert.equal(recorders.length, 2, "a new part at 30 minutes, long before the five hours a file may hold");
  for (let part = 3; part <= 10; part += 1) {
    now = (part - 1) * 30 * 60_000;
    recorders.at(-1)!.emit("x");
  }
  assert.equal(recorders.length, 10, "ten parts of 30 minutes");
  now = FIVE_HOURS - 60_000 - 9 * 1_000 - 1;
  recorders.at(-1)!.emit("x");
  assert.equal(capture.getSnapshot().status, "recording");
  now += 1;
  recorders.at(-1)!.emit("x");
  await until(() => capture.getSnapshot().status === "stopped", "the stop before Eneo's longest recording");
  assert.equal(recorders.length, 10, "no eleventh part");
  assert.match(capture.getSnapshot().error ?? "", /^Inspelningen nådde maxlängden 5\u00a0h och stoppades/);
});

test("when the file slots run out before the time, the stop says so rather than a length", async () => {
  let now = 0;
  const { capture, recorders } = await setup({ now: () => now });
  await capture.start(meeting, ONE_RECORDING);
  now = 60_000;
  recorders[0].emit("a");
  const stopped = (await capture.stop())!; // stopped by mistake after a minute
  await capture.continueStopped(stopped, ONE_RECORDING);
  for (let part = 2; part <= 10; part += 1) {
    now += 30 * 60_000;
    recorders.at(-1)!.emit("x");
  }
  await until(() => capture.getSnapshot().status === "stopped", "the stop at the last file");
  assert.equal(recorders.length, 10);
  assert.equal(
    capture.getSnapshot().error,
    "Inspelningen stoppades efter 4\u00a0h\u00a031\u00a0min: flödet tar emot högst 10 filer. Den är sparad. Skicka den, eller starta en ny inspelning för resten av mötet.",
  );
});

test("the recording's time left counts every part so far", async () => {
  let now = 0;
  const { capture, recorders } = await setup({ now: () => now });
  await capture.start(meeting, ONE_RECORDING);
  now = 45 * 60_000;
  recorders.at(-1)!.emit("x");
  assert.equal(recorders.length, 2);
  // 45 minutes recorded, one handover so far.
  assert.equal(capture.timeLeftMs(), FIVE_HOURS - 45 * 60_000 - 60_000 - 1_000);
});

test("the stop comes by the recorded clock in the last part too, with its handover's room", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { capture, recorders, advance } = await clocked(t);
  await capture.start(meeting, { ...ONE_RECORDING, partMs: FIVE_HOURS / 2 });
  advance(FIVE_HOURS / 2);
  assert.equal(recorders.length, 2);
  // No chunk arrives (a locked phone): the timer alone must stop before the room of a minute and one handover.
  advance(FIVE_HOURS / 2 - 60_000 - 1_000 - 1);
  assert.equal(capture.getSnapshot().limitReached, false);
  advance(1);
  assert.equal(capture.getSnapshot().limitReached, true);
});

const OUT_OF_TIME =
  "Inspelningen har nått flödets maxlängd 5\u00a0h. Skicka den, eller starta en ny inspelning för resten av mötet.";

test("a recording with no time left is not continued, and no microphone is opened", async () => {
  let now = 0;
  const { capture, recorders, streams } = await setup({ now: () => now });
  await capture.start(meeting, { ...ONE_RECORDING, partMs: FIVE_HOURS });
  now = FIVE_HOURS - 60_000 - 500; // a page the browser suspended stopped it this late
  recorders[0].emit("a");
  const stopped = (await capture.stop())!;
  assert.equal(streams.length, 1);

  await capture.continueStopped(stopped, ONE_RECORDING);

  assert.deepEqual([capture.getSnapshot().status, capture.getSnapshot().error], ["stopped", OUT_OF_TIME]);
  assert.equal(streams.length, 1, "no microphone opened");
  assert.equal(recorders.length, 1, "no new part");
});

test("a short limit keeps 5 % as room rather than a whole minute", async () => {
  let now = 0;
  const { capture, recorders } = await setup({ now: () => now });
  await capture.start(meeting, { maxDurationMs: 10 * 60_000, maxBytes: 10 ** 12, maxFiles: 2 });
  now = 9 * 60_000 + 29_000;
  recorders[0].emit("x");
  assert.equal(recorders.length, 1);
  now = 9 * 60_000 + 30_000; // 30 s, 5 % of ten minutes, before the limit
  recorders[0].emit("x");
  assert.equal(recorders.length, 2);
});

/** A recorder whose clock moves with the test's mocked timers. */
async function clocked(t: import("node:test").TestContext) {
  let now = 0;
  const made = await setup({ now: () => now });
  return {
    ...made,
    advance(ms: number) {
      now += ms;
      t.mock.timers.tick(ms);
    },
  };
}

test("the handover comes at Eneo's time by the recorded clock, even when the browser holds the chunks back", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { capture, recorders, advance } = await clocked(t);
  await capture.start(meeting, { maxDurationMs: 5 * HOUR, maxBytes: 10 ** 12, maxFiles: 2 });
  advance(4 * HOUR); // a locked phone: no chunk arrives
  assert.equal(recorders.length, 1);
  advance(HOUR - 60_000);
  assert.equal(recorders.length, 2, "at 4:59, with no chunk since the start");
  advance(150);
  await settle();
  assert.equal(recorders[0].state, "inactive", "the full part ends after the overlap");
});

test("a pause stops the handover's clock, and going on starts it again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { capture, recorders, advance } = await clocked(t);
  await capture.start(meeting, { maxDurationMs: 5 * HOUR, maxBytes: 10 ** 12, maxFiles: 2 });
  advance(4 * HOUR);
  capture.togglePause();
  advance(2 * HOUR); // past the deadline on the wall clock, not on the recorded one
  assert.equal(recorders.length, 1, "no handover while paused");
  capture.togglePause();
  advance(HOUR - 61_000);
  assert.equal(recorders.length, 1);
  advance(1_000);
  assert.equal(recorders.length, 2, "at 4:59 recorded");
});

test("a stopped or left recording leaves no handover behind", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const end of ["stop", "leave"] as const) {
    const { capture, recorders, advance } = await clocked(t);
    await capture.start(meeting, { maxDurationMs: 5 * HOUR, maxBytes: 10 ** 12, maxFiles: 2 });
    if (end === "stop") await capture.stop();
    else capture.dispose();
    await settle();
    advance(6 * HOUR);
    await settle();
    assert.equal(recorders.length, 1, `${end}: no new part afterwards`);
  }
});

/** Timers as a browser keeps them: whole milliseconds, cut down; `early` fires them that much before their time. */
function browserTimers(t: import("node:test").TestContext, early = 0) {
  const mocked = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms = 0) => mocked(fn, Math.max(0, Math.floor(ms) - early))) as typeof setTimeout;
  t.after(() => {
    globalThis.setTimeout = mocked;
  });
}

test("a deadline a fraction of a millisecond away still hands over: the delay rounds up", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  browserTimers(t);
  const { capture, recorders, advance } = await clocked(t);
  await capture.start(meeting, { maxDurationMs: 10_000, maxBytes: 10 ** 12, maxFiles: 2 });
  advance(0.5);
  capture.togglePause();
  capture.togglePause(); // the deadline is now 7,999.5 ms of recording away
  advance(7_999); // a browser would fire a 7,999.5 ms timer here, still short of it
  advance(4_000);
  assert.equal(recorders.length, 2, "handed over, not left recording past the limit");
});

test("a timer that fires a little early is set again for the rest", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  browserTimers(t, 0.5);
  const { capture, recorders, advance } = await clocked(t);
  await capture.start(meeting, { maxDurationMs: 10_000, maxBytes: 10 ** 12, maxFiles: 2 });
  advance(7_999.5); // the handover's timer fires here, half a millisecond before its 8 s
  assert.equal(recorders.length, 1);
  advance(0.5);
  assert.equal(recorders.length, 2, "and hands over at its time");
});

test("Stoppa just before the deadline starts no other recorder", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { capture, recorders, advance } = await clocked(t);
  await capture.start(meeting, { maxDurationMs: 10_000, maxBytes: 10 ** 12, maxFiles: 2 });
  advance(7_999);
  const stopped = capture.stop(); // the recorder's stop event comes after the deadline
  advance(1);
  await stopped;
  assert.equal(capture.getSnapshot().status, "stopped");
  assert.equal(recorders.length, 1, "no new part for a recording that is stopping");
  assert.ok(recorders.every((recorder) => recorder.state === "inactive"));
});

test("a handover timer that fires late, after Pausa, leaves the recording paused", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  browserTimers(t, -5); // the 8 s deadline fires 5 ms late
  const { capture, recorders, advance } = await clocked(t);
  await capture.start(meeting, { maxDurationMs: 10_000, maxBytes: 10 ** 12, maxFiles: 2 });
  advance(8_001);
  capture.togglePause(); // Pausa, before the late deadline
  advance(10);
  assert.equal(capture.getSnapshot().status, "paused", "Pausa holds");
  assert.equal(recorders.length, 1, "no new part while paused");
  capture.togglePause();
  advance(10); // the new deadline is already due, and fires 5 ms late too
  assert.equal(recorders.length, 2, "going on hands over");
});

test("a chunk that arrives after Pausa leaves the recording paused", async () => {
  let now = 0;
  const { capture, recorders } = await setup({ now: () => now });
  await capture.start(meeting, { maxDurationMs: 10_000, maxBytes: 10 ** 12, maxFiles: 2 });
  now = 8_001;
  capture.togglePause();
  recorders[0].emit("x"); // the browser hands over its last chunk after the pause
  assert.equal(capture.getSnapshot().status, "paused");
  assert.equal(recorders.length, 1, "no new part while paused");
});

test("a short limit keeps room for the overlap and a late timer", async () => {
  let now = 0;
  const { capture, recorders } = await setup({ now: () => now });
  await capture.start(meeting, { maxDurationMs: 10_000, maxBytes: 10 ** 12, maxFiles: 2 });
  now = 7_999;
  recorders[0].emit("x");
  assert.equal(recorders.length, 1);
  now = 8_000; // two seconds before a ten-second limit, not 5 % (half a second)
  recorders[0].emit("x");
  assert.equal(recorders.length, 2);
});

test("a limit that is not whole hours is said in the module's durations", async () => {
  let now = 0;
  const { capture, recorders } = await setup({ now: () => now });
  await capture.start(meeting, { maxDurationMs: 90 * 60_000, maxBytes: 10 ** 12, maxFiles: 1 });
  now = 89 * 60_000;
  recorders[0].emit("x");
  await until(() => capture.getSnapshot().status === "stopped", "the stop");
  assert.equal(
    capture.getSnapshot().error,
    "Inspelningen nådde maxlängden 1\u00a0h\u00a030\u00a0min och stoppades efter 1\u00a0h\u00a029\u00a0min. Den är sparad. Skicka den, eller starta en ny inspelning för resten av mötet.",
  );
});

test("when the flow's last file reaches Eneo's time the recording stops, says when and what to do, and keeps everything", async () => {
  let now = 0;
  const { capture, store, recorders } = await setup({ now: () => now });
  await capture.start(meeting, { maxDurationMs: FIVE_HOURS, maxBytes: 10 ** 12, maxFiles: 1 });
  now = 5 * HOUR - 16 * 60_000;
  recorders[0].emit("a");
  assert.equal(capture.timeLeftMs(), 15 * 60_000, "15 minutes left: the bar says so");
  now = 5 * HOUR - 60_000;
  recorders[0].emit("b");
  await until(() => capture.getSnapshot().status === "stopped", "the stop at the limit");
  const snapshot = capture.getSnapshot();
  assert.equal(snapshot.limitReached, true);
  assert.equal(snapshot.remainingMs, 0);
  assert.equal(
    snapshot.error,
    "Inspelningen nådde maxlängden 5\u00a0h och stoppades efter 4\u00a0h\u00a059\u00a0min. Den är sparad. Skicka den, eller starta en ny inspelning för resten av mötet.",
  );
  assert.equal(recorders.length, 1, "no second part");
  assert.deepEqual(await texts(await store.readParts(snapshot.recording!.id)), ["ab."], "every chunk, the last one too");
});

test("a stop, a page leave or a lost microphone during the overlap stops the full part first and keeps both parts once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [what, end] of [
    ["stop", (capture: RecordingCapture) => void capture.stop()],
    ["page leave", (capture: RecordingCapture) => capture.dispose()],
    ["lost microphone", (_capture: RecordingCapture, stream: FakeStream) => stream.track.lose("ended")],
  ] as const) {
    const { capture, store, streams, recorders } = await setup();
    await capture.start(meeting, { maxBytes: LIMIT });
    for (let i = 0; i < 5; i += 1) recorders[0].emit(CHUNK);
    recorders[1].emit("new");
    const stopped: number[] = [];
    recorders.forEach((recorder, index) => recorder.addEventListener("stop", () => stopped.push(index)));
    end(capture, streams[0]);
    await until(() => streams[0].track.readyState === "ended", `${what}: the microphone let go`);
    await settle();
    assert.deepEqual(stopped, [0, 1], what);
    const files = await store.readParts(capture.getSnapshot().recording!.id);
    assert.deepEqual(files.map((file) => file.blob.size), [5 * 8_000 + 1, 3 + 1], what);
    t.mock.timers.tick(150); // the overlap's own stop finds nothing left to stop
  }
});

test("after an interruption, 'Fortsätt spela in' is refused once the flow takes no more files", async () => {
  const { capture, streams, recorders } = await setup();
  await capture.start(meeting, { maxBytes: LIMIT, maxFiles: 1 });
  recorders[0].emit(CHUNK);
  streams[0].track.lose("ended");
  await until(() => capture.getSnapshot().status === "interrupted", "the pause");
  assert.equal(capture.timeLeftMs(), 0, "nothing more fits");

  await capture.continueRecording();
  assert.equal(capture.getSnapshot().status, "interrupted");
  assert.equal(
    capture.getSnapshot().error,
    "Flödet tar emot högst 1 fil, och inspelningen har redan så många delar.",
  );
  assert.equal(streams.length, 1, "no new microphone");
});

test("a part that got no audio is no file, so the recording still continues, or reopens, within the flow's file count", async () => {
  const device = { indexedDB: new IDBFactory(), keyRange: IDBKeyRange, locks: fakeWebLocks() };
  const limits = { maxBytes: LIMIT, maxFiles: 2 };
  const { capture, store, streams, recorders } = await setup({ store: await openRecordingStore(device) });
  await capture.start(meeting, limits);
  recorders[0].emit("a");
  streams[0].track.lose("ended");
  await until(() => capture.getSnapshot().status === "interrupted", "the pause");
  await capture.continueRecording();
  recorders[1].lastData = ""; // the microphone goes again before anything is recorded
  streams[1].track.lose("ended");
  await until(() => capture.getSnapshot().error === null && capture.getSnapshot().status === "interrupted", "the second pause");
  await capture.continueRecording();
  assert.equal(capture.getSnapshot().status, "recording", "one file so far");
  // The tab dies before this part records anything either.
  const { id } = capture.getSnapshot().recording!;
  assert.equal((await store.get(id))?.parts.length, 3);
  store.release(id);

  const reloaded = await setup({ store: await openRecordingStore(device) });
  await reloaded.capture.adopt((await reloaded.store.get(id))!, limits);
  assert.equal(reloaded.capture.getSnapshot().status, "recording", "still one file");
  reloaded.recorders[0].emit("b");
  await reloaded.capture.stop();
  assert.deepEqual(await texts(await reloaded.store.readParts(id)), ["a.", "b."]);
});

test("a new part the browser will not start pauses the recording instead of recording nothing", async () => {
  const store = await openRecordingStore({});
  const stream = new FakeStream();
  const recorders: FakeRecorder[] = [];
  const capture = new RecordingCapture(() => store, {
    getStream: async () => stream as unknown as MediaStream,
    createRecorder: (_stream, options) => {
      if (recorders.length === 1) throw new DOMException("Recorder unavailable", "NotSupportedError");
      const recorder = new FakeRecorder(stream, options);
      recorders.push(recorder);
      return recorder as unknown as MediaRecorder;
    },
  });
  await capture.start(meeting, { maxBytes: LIMIT });
  for (let i = 0; i < 5; i += 1) recorders[0].emit(CHUNK);
  await until(() => capture.getSnapshot().status === "interrupted", "the pause");
  const paused = capture.getSnapshot().recording!;
  assert.equal(paused.state, "paused");
  assert.deepEqual((await store.readParts(paused.id)).map((file) => file.blob.size), [5 * 8_000 + 1]);
});

test("a denied microphone, or a recorder that cannot start, says so in Swedish and leaves nothing behind", async () => {
  const store = await openRecordingStore({});
  const denied = new RecordingCapture(() => store, {
    getStream: async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    },
    createRecorder: () => {
      throw new Error("not reached");
    },
  });
  await denied.start(meeting);
  assert.equal(denied.getSnapshot().status, "idle");
  assert.equal(denied.getSnapshot().error, "Tillåt mikrofonen i webbläsaren för att spela in.");

  // Also on a shared device store without Web Locks, where only the lease holder may delete a live-looking recording.
  for (const shared of [store, await openRecordingStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })]) {
    const stream = new FakeStream();
    const unsupported = new RecordingCapture(() => shared, {
      getStream: async () => stream as unknown as MediaStream,
      createRecorder: () => {
        throw new DOMException("Unsupported MIME type", "NotSupportedError");
      },
    });
    await unsupported.start(meeting);
    assert.equal(unsupported.getSnapshot().status, "idle");
    assert.match(unsupported.getSnapshot().error ?? "", /kunde inte startas/);
    assert.equal(stream.track.readyState, "ended", "the microphone is let go");
    assert.deepEqual(await shared.listUnsent("user-1"), []);
  }
});

test("the recorder says when space runs low or the device stops keeping the recording", async () => {
  const MB = 1024 * 1024;
  let usage = 0;
  const store = await openRecordingStore({
    indexedDB: new IDBFactory(),
    keyRange: IDBKeyRange,
    storage: { persist: async () => true, estimate: async () => ({ usage, quota: 1_000 * MB }) },
  });
  const { capture, recorders } = await setup({ store });
  await capture.start(meeting);
  assert.deepEqual([capture.getSnapshot().lowSpace, capture.getSnapshot().persistent], [false, true]);

  usage = 950 * MB;
  for (let i = 0; i < 30; i += 1) recorders[0].emit("x");
  await until(() => capture.getSnapshot().lowSpace, "the low-space warning");

  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
    if (this.name === "chunks") throw new DOMException("Disk full", "QuotaExceededError");
    return put.apply(this, args);
  };
  try {
    recorders[0].emit("y");
    await until(() => !capture.getSnapshot().persistent, "the lives-only-in-this-tab notice");
    assert.equal(capture.getSnapshot().refused, "full", "the device is full, and the recorder says so");
    recorders[0].emit("z");
    await settle();
    assert.equal(capture.getSnapshot().status, "recording", "and records on, into this tab");
  } finally {
    IDBObjectStore.prototype.put = put;
  }
  const { id } = capture.getSnapshot().recording!;
  assert.match((await texts(await store.readParts(id)))[0], /yz$/, "nothing recorded after the refusal is lost");
  await capture.stop();
  assert.equal(capture.getSnapshot().persistent, false, "the ready state after Stoppa still says so");
});

/** The device has no room for a chunk until the returned function gives it room again. */
function fillDevice(): () => void {
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
    if (this.name === "chunks") throw new DOMException("Disk full", "QuotaExceededError");
    return put.apply(this, args);
  };
  return () => void (IDBObjectStore.prototype.put = put);
}

/** A device that fills up during a recording: its store, the store's try of the full device (run by the test), and its database. */
async function fillingDevice() {
  const indexedDB = new IDBFactory();
  const retry = { run: () => {} };
  const env = { indexedDB, keyRange: IDBKeyRange, locks: fakeWebLocks(), timer: (run: () => void) => void (retry.run = run) };
  const store = await openRecordingStore(env);
  const { capture, recorders } = await setup({ store });
  await capture.start(meeting);
  const { id } = capture.getSnapshot().recording!;
  recorders[0].emit("a");
  const room = fillDevice();
  try {
    recorders[0].emit("b");
    await until(() => capture.getSnapshot().refused === "full", "the full device said");
  } finally {
    room(); // the person frees room; the store has not tried the device again yet
  }
  return { capture, recorders, store, id, retry: () => retry.run(), otherTab: () => openRecordingStore({ ...env, timer: undefined }) };
}

test("once the full device has room again the warning goes, a note says the recording is kept on the device again for a moment, and recording goes on there", async (t) => {
  const { capture, recorders, id, retry, otherTab } = await fillingDevice();
  assert.deepEqual([capture.getSnapshot().persistent, capture.getSnapshot().backOnDevice], [false, false]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  retry();
  await until(() => capture.getSnapshot().refused === null, "back on the device");
  assert.deepEqual([capture.getSnapshot().persistent, capture.getSnapshot().backOnDevice], [true, true]);
  t.mock.timers.tick(9_999);
  assert.equal(capture.getSnapshot().backOnDevice, true);
  t.mock.timers.tick(1);
  assert.equal(capture.getSnapshot().backOnDevice, false, "said for ten seconds");
  recorders[0].emit("c");
  await until(async () => (await (await otherTab()).get(id))?.parts[0]?.chunks === 3, "the next chunk on the device");
});

test("Stoppa while the recording goes back onto the device keeps every chunk on the device, in order, and the ready state says it is kept there", async () => {
  const { capture, recorders, id, retry, otherTab } = await fillingDevice();
  retry(); // the move is in the store's queue
  recorders[0].emit("c");
  const stopped = await capture.stop();
  assert.equal(stopped?.state, "stopped");
  assert.equal(capture.getSnapshot().persistent, true);
  assert.deepEqual(await texts(await (await otherTab()).readPartsToSend(id)), ["abc."], "the device alone has all of it");
});

test("a full device that has room again after Stoppa takes the recording back, and the ready state follows", async () => {
  const { capture, retry, id, otherTab } = await fillingDevice();
  await capture.stop();
  assert.deepEqual([capture.getSnapshot().persistent, capture.getSnapshot().refused], [false, "full"], "said while only this tab has part of it");
  retry();
  await until(() => capture.getSnapshot().persistent, "kept on the device again");
  assert.equal(capture.getSnapshot().refused, null);
  assert.equal(capture.getSnapshot().backOnDevice, false, "the note is the recording bar's, which is gone");
  assert.deepEqual(await texts(await (await otherTab()).readPartsToSend(id)), ["ab."]);
});

/** The screen's wake lock as the browser hands it out: released by the page, or by the system (`lose`). */
class FakeWakeLock extends EventTarget {
  released = false;
  async release() {
    this.lose();
  }
  lose() {
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event("release"));
  }
}

test("a wake lock the browser refuses or lets go of says so, and a later one that is granted takes it back", async () => {
  const { page, show } = fakePage();
  let grant = false;
  const locks: FakeWakeLock[] = [];
  const { capture } = await setup({
    page,
    requestWakeLock: async () => {
      if (!grant) throw new DOMException("Wake Lock permission request denied", "NotAllowedError");
      const lock = new FakeWakeLock();
      locks.push(lock);
      return lock;
    },
  });
  await capture.start(meeting);
  assert.equal(capture.getSnapshot().screenMayDim, true, "refused: the screen may go dark");

  grant = true;
  show("hidden");
  show("visible"); // asked again, and granted
  await until(() => !capture.getSnapshot().screenMayDim, "the lock taken back");

  locks[0].lose(); // the system lets it go (a battery saver)
  assert.equal(capture.getSnapshot().screenMayDim, true, "said at once");
  show("hidden");
  show("visible");
  await until(() => !capture.getSnapshot().screenMayDim, "granted again");

  show("hidden");
  locks[1].lose(); // every hidden page loses it, and asks again when it is shown
  assert.equal(capture.getSnapshot().screenMayDim, false, "not said for a hidden page");
  show("visible");
  await until(() => locks.length === 3, "asked again");
  assert.equal(capture.getSnapshot().screenMayDim, false);

  await capture.stop();
  assert.equal(locks[2].released, true, "the page lets its lock go at Stoppa");
  assert.equal(capture.getSnapshot().screenMayDim, false, "its own release is no loss");
});

test("a browser without a wake lock says so, and two requests that cross leave one lock, released at Stoppa", async () => {
  const none = await setup({ requestWakeLock: async () => null });
  await none.capture.start(meeting);
  assert.equal(none.capture.getSnapshot().screenMayDim, true);

  let grant = () => {};
  const wakeLock = new Promise<void>((resolve) => (grant = resolve));
  const { page, show } = fakePage();
  const { capture, wakeLocks } = await setup({ page, wakeLock });
  const starting = capture.start(meeting); // asks for the lock, and waits
  await until(() => capture.getSnapshot().status === "recording", "recording");
  show("hidden");
  show("visible"); // asks again while the first is unanswered
  grant();
  await starting;
  await until(() => wakeLocks.requested === 2 && wakeLocks.released === 1, "the earlier lock let go");
  await capture.stop();
  assert.equal(wakeLocks.released, 2, "and the later one at Stoppa: none is left holding the screen on");
});

test("a stop can be taken back with Fortsätt spela in only while the flow takes a further part, and the recorder says which", async () => {
  const one = await setup();
  await one.capture.start(meeting, { maxBytes: 10 ** 12, maxFiles: 1 });
  assert.equal(one.capture.continuesAfterStop(), false, "a flow of one file");
  one.recorders[0].emit("a");
  one.capture.togglePause();
  assert.equal(one.capture.continuesAfterStop(), false, "paused too");
  const stoppedOne = await one.capture.stop();
  assert.equal(mayContinue(stoppedOne!, { maxBytes: 10 ** 12, maxFiles: 1 }), false, "and the stored recording says the same");

  const two = await setup();
  await two.capture.start(meeting, { maxBytes: 10 ** 12, maxFiles: 2 });
  assert.equal(two.capture.continuesAfterStop(), true);
  two.recorders[0].emit("a");
  const stoppedTwo = await two.capture.stop();
  assert.equal(mayContinue(stoppedTwo!, { maxBytes: 10 ** 12, maxFiles: 2 }), true);

  const open = await setup();
  await open.capture.start(meeting);
  assert.equal(open.capture.continuesAfterStop(), true, "a flow without limits");

  let now = 0;
  const timed = await setup({ now: () => now });
  await timed.capture.start(meeting, { maxFiles: 10, partMs: 30 * 60_000, maxRecordingMs: 60 * 60_000 });
  now = 50 * 60_000;
  assert.equal(timed.capture.continuesAfterStop(), true, "time for a part after this one");
  now = 59 * 60_000;
  assert.equal(timed.capture.continuesAfterStop(), false, "no time left for another part before the longest recording");
});

test("an unconfirmed recorder keeps its writer lease through disposal and letGo, then permits another tab after its real stop", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  for (const how of ["dispose", "reset"] as const) {
    const env = { indexedDB: new IDBFactory(), keyRange: IDBKeyRange, locks: fakeWebLocks() };
    const store = await openRecordingStore(env);
    const tab = await openRecordingStore(env);
    const { capture, recorders } = await setup({ store });
    await capture.start(meeting);
    recorders[0].emit("OLD_PREFIX");
    recorders[0].stop = () => void (recorders[0].state = "inactive");
    const id = capture.getSnapshot().recording!.id;
    if (how === "dispose") {
      capture.dispose();
      t.mock.timers.tick(4_000);
    } else {
      const stopped = capture.stop();
      t.mock.timers.tick(4_000);
      await stopped;
      capture.reset();
    }
    await until(async () => (await store.get(id))?.state === (how === "dispose" ? "paused" : "stopped"));
    store.letGo(id);
    assert.equal(await tab.lease(id), false, "the old recorder still owns final audio");
    recorders[0].emit("OLD_FINAL");
    await until(async () => (await texts(await store.readParts(id)))[0] === "OLD_PREFIXOLD_FINAL");
    assert.equal(await tab.lease(id), false, "delayed audio does not release ownership");
    recorders[0].dispatchEvent(new Event("stop"));
    await until(() => tab.lease(id), "the next tab acquires only once the writer ends");
    const part = await tab.startPart(id);
    await tab.append(id, part, new Blob(["NEW_1"]), 1_000);
    await tab.append(id, part, new Blob(["NEW_2"]), 2_000);
    assert.deepEqual(await texts(await tab.readParts(id)), ["OLD_PREFIXOLD_FINAL", "NEW_1NEW_2"]);
    tab.release(id);
  }
});
