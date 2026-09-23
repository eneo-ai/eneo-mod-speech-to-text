import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";

import {
  openRecordingStore,
  type NewRecording,
  type RecordingFile,
  type RecordingStore,
} from "./recording-store";
import { fakeWebLocks } from "./fake-web-locks";
import { createOnlineStatus } from "./online-status";
import { RecordingCapture, type CaptureDeps, type PageLike } from "./recording-session";
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

async function setup(
  options: {
    store?: RecordingStore;
    page?: PageLike;
    now?: () => number;
    /** A denied microphone, or one the browser grants only once `wait` settles. */
    microphone?: { denied?: boolean; wait?: Promise<void> };
  } = {},
) {
  const store = options.store ?? (await openRecordingStore({}));
  const streams: FakeStream[] = [];
  const constraints: MediaStreamConstraints[] = [];
  const recorders: FakeRecorder[] = [];
  const wakeLocks = { requested: 0, released: 0 };
  const deps: CaptureDeps = {
    getStream: async (asked) => {
      if (options.microphone?.denied) throw new DOMException("Permission denied", "NotAllowedError");
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
    requestWakeLock: async () => {
      wakeLocks.requested += 1;
      return {
        release: async () => {
          wakeLocks.released += 1;
        },
      };
    },
    page: options.page,
  };
  return { capture: new RecordingCapture(() => store, deps), store, streams, constraints, recorders, wakeLocks };
}

test("losing the microphone pauses the recording, keeps what was recorded, and 'Fortsätt spela in' records a new part", async () => {
  const { capture, store, streams, recorders } = await setup();
  await capture.start(meeting);
  assert.equal(capture.getSnapshot().status, "recording");
  assert.equal(recorders[0].timeslice, 2_000);
  assert.equal(recorders[0].mimeType, "audio/webm;codecs=opus");
  recorders[0].emit("a");
  recorders[0].emit("b");

  streams[0].track.lose("mute"); // a phone call takes the microphone
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

test("a hidden page stores what is recorded so far; back with a working microphone it keeps recording, with a muted one it pauses", async () => {
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
  streams[0].track.muted = true; // muted while hidden, without an event reaching the page
  show("visible");
  await until(() => capture.getSnapshot().status === "interrupted", "the pause");
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
  streams[0].track.lose("mute");
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
  await capture.adopt(id);
  assert.equal(capture.getSnapshot().status, "recording", "the same surface as a new recording");
  assert.deepEqual(constraints, [{ audio: { channelCount: 1 } }]);
  assert.equal(capture.getSnapshot().recording?.id, id);
  assert.equal(capture.elapsedMs(), 2_000, "the time goes on from what was recorded");
  assert.equal(capture.getSnapshot().recordedBytes, 1, "and so does the size");
  assert.deepEqual(await store.listUnsent("user-1"), [], "this tab holds it now");

  now = 91_000;
  recorders[0].emit("b");
  assert.equal(capture.elapsedMs(), 3_000);
  const stopped = await capture.stop();
  assert.equal(stopped?.id, id, "one recording, so one run");
  assert.equal(stopped?.durationMs, 3_000);
  assert.deepEqual(await texts(await store.readParts(id)), ["a", "b."], "the earlier part is unchanged");
});

test("only an interrupted recording that no other tab holds, and that the flow takes another file for, can be continued", async () => {
  const device = { indexedDB: new IDBFactory(), keyRange: IDBKeyRange, locks: fakeWebLocks() };
  const otherTab = await openRecordingStore(device);
  const held = await otherTab.create(meeting);
  const finished = await otherTab.create(meeting);
  await otherTab.setState(finished.id, "stopped");
  otherTab.release(finished.id);
  const full = await otherTab.create(meeting);
  await otherTab.startPart(full.id);
  await otherTab.append(full.id, 0, new Blob(["a"]), 1_000);
  otherTab.release(full.id);

  const { capture, streams } = await setup({ store: await openRecordingStore(device) });
  await capture.adopt(held.id);
  assert.equal(capture.getSnapshot().status, "idle");
  assert.equal(capture.getSnapshot().error, "Inspelningen används i en annan flik.");
  await capture.adopt(finished.id);
  assert.equal(capture.getSnapshot().error, "Inspelningen är avslutad och kan inte fortsätta.");
  await capture.adopt(full.id, { maxBytes: LIMIT, maxFiles: 1 });
  assert.equal(capture.getSnapshot().status, "idle");
  assert.equal(
    capture.getSnapshot().error,
    "Flödet tar emot högst 1 fil, och inspelningen har redan så många delar.",
  );
  assert.equal(streams.length, 0, "the microphone was never opened");

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
    await unreadable.capture.adopt(held.id);
  } finally {
    IDBObjectStore.prototype.get = get;
  }
  assert.equal(unreadable.capture.getSnapshot().error, "Inspelningen kunde inte öppnas.");
  assert.equal(await reopened.lease(held.id), true, "nobody holds it");
  reopened.release(held.id);

  // A page that goes away while it opens one leaves it for recovery.
  await settle();
  const leaving = await setup({ store: await openRecordingStore(device) });
  const adopting = leaving.capture.adopt(held.id);
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

test("after Stoppa, 'Fortsätt spela in' records on in a new part of the same recording", async () => {
  let now = 0;
  const { capture, store, recorders } = await setup({ now: () => now });
  const limits = { maxBytes: LIMIT, maxFiles: 2 };
  await capture.start(meeting, limits);
  now = 2_000;
  recorders[0].emit("a");
  const stopped = (await capture.stop())!;

  await capture.continueStopped(stopped.id, limits);
  assert.equal(capture.getSnapshot().status, "recording");
  assert.equal(capture.elapsedMs(), 2_000, "the time goes on from what was recorded");
  assert.equal(capture.getSnapshot().remainingMs, 8_350, "in the last file the flow takes");
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
  await until(async () => (await store.get(stopped.id))?.state === "uploading", "the send");
  await capture.continueStopped(stopped.id, limits);
  const refused = capture.getSnapshot();
  assert.deepEqual([refused.status, refused.recording?.id, refused.error], ["stopped", stopped.id, SEND_BEGUN]);
  assert.equal(streams.length, 1, "no microphone opened");

  finishUpload();
  await sending;
  await capture.continueStopped(stopped.id, limits);
  assert.equal(capture.getSnapshot().error, GONE, "sent, and its copy deleted");

  // A send whose tab died while Eneo made the run, and a sent one whose copy could not be deleted.
  for (const state of ["uploaded", "submitted"] as const) {
    const left = await stoppedCapture();
    await left.store.setState(left.stopped.id, state);
    await left.capture.continueStopped(left.stopped.id, limits);
    assert.equal(left.capture.getSnapshot().error, SEND_BEGUN, state);
    assert.equal(left.streams.length, 1, state);
  }
});

test("a stopped recording is not continued while another tab holds it, once it is deleted, past the flow's file count or without a microphone", async () => {
  const device = { indexedDB: new IDBFactory(), keyRange: IDBKeyRange, locks: fakeWebLocks() };
  const limits = { maxBytes: LIMIT, maxFiles: 3 };
  const { capture, store, streams, stopped } = await stoppedCapture({ store: await openRecordingStore(device) });
  const otherTab = await openRecordingStore(device);
  assert.equal(await otherTab.lease(stopped.id), true);
  await capture.continueStopped(stopped.id, limits);
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
  await capture.continueStopped(stopped.id, limits);
  assert.equal(capture.getSnapshot().error, GONE);
  assert.equal(streams.length, 1, "no microphone opened");

  const full = await stoppedCapture();
  await full.capture.continueStopped(full.stopped.id, { maxBytes: LIMIT, maxFiles: 1 });
  assert.equal(
    full.capture.getSnapshot().error,
    "Flödet tar emot högst 1 fil, och inspelningen har redan så många delar.",
  );

  const microphone = { denied: false };
  const denied = await stoppedCapture({ microphone });
  microphone.denied = true;
  await denied.capture.continueStopped(denied.stopped.id, limits);
  assert.deepEqual(
    [denied.capture.getSnapshot().status, denied.capture.getSnapshot().error],
    ["stopped", "Tillåt mikrofonen i webbläsaren för att spela in."],
  );
  assert.equal(await denied.store.lease(denied.stopped.id), true, "its lease let go");
});

test("Stoppa while 'Fortsätt spela in' waits for the microphone starts no recorder afterwards", async () => {
  const microphone: { wait?: Promise<void> } = {};
  const { capture, store, streams, recorders } = await setup({ microphone });
  await capture.start(meeting);
  recorders[0].emit("a");
  streams[0].track.lose("mute");
  await until(() => capture.getSnapshot().status === "interrupted", "the pause");

  let grant = () => {};
  microphone.wait = new Promise((resolve) => (grant = resolve));
  const continuing = capture.continueRecording();
  const stopped = await capture.stop();
  grant();
  await continuing;

  assert.equal(recorders.length, 1, "no recorder after Stoppa");
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
  const continuing = later.continueStopped(made.id);
  await until(() => asked, "the microphone asked for");
  later.dispose();
  estimate();
  await continuing;
  assert.equal(recorders, 0);
  assert.equal(second.track.readyState, "ended");
  assert.equal(await slow.lease(made.id), true, "nothing holds the recording");
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
  assert.equal(capture.getSnapshot().partBytes, 0, "the full part's last chunk is its own");
  assert.equal(capture.getSnapshot().remainingMs, 16_700, "the new part and one more");
  assert.equal(streams.length, 1, "the same microphone: no new permission");
  assert.equal(streams[0].track.readyState, "live");
  assert.equal(capture.getSnapshot().status, "recording");
  assert.equal(capture.getSnapshot().error, null);

  recorders[1].emit("new");
  assert.equal(capture.getSnapshot().recordedBytes, 5 * 8_000 + 1 + 3, "the size shown counts every part");
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
  assert.equal(unbounded.capture.getSnapshot().remainingMs, null, "no file count, no end");

  const { capture, recorders } = await setup();
  await capture.start(meeting, { maxBytes: LIMIT, maxFiles: 2 });
  // Each part holds 50 000 − 16 600 B before the next starts: 8 350 ms at 32 kbit/s.
  assert.equal(capture.getSnapshot().remainingMs, 16_700);
  recorders[0].emit(CHUNK);
  assert.equal(capture.getSnapshot().remainingMs, 14_700);
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

test("a stop, a page leave or a lost microphone during the overlap stops the full part first and keeps both parts once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [what, end] of [
    ["stop", (capture: RecordingCapture) => void capture.stop()],
    ["page leave", (capture: RecordingCapture) => capture.dispose()],
    ["lost microphone", (_capture: RecordingCapture, stream: FakeStream) => stream.track.lose("mute")],
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
  streams[0].track.lose("mute");
  await until(() => capture.getSnapshot().status === "interrupted", "the pause");
  assert.equal(capture.getSnapshot().remainingMs, 0, "nothing more fits");

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
  streams[0].track.lose("mute");
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
  await reloaded.capture.adopt(id, limits);
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
  } finally {
    IDBObjectStore.prototype.put = put;
  }
});
