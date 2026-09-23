import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";

import {
  openRecordingStore,
  type NewRecording,
  type RecordingFile,
  type RecordingStore,
} from "./recording-store";
import { RecordingCapture, type CaptureDeps, type PageLike } from "./recording-session";

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
      this.emit(".");
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

async function setup(options: { store?: RecordingStore; page?: PageLike; now?: () => number } = {}) {
  const store = options.store ?? (await openRecordingStore({}));
  const streams: FakeStream[] = [];
  const constraints: MediaStreamConstraints[] = [];
  const recorders: FakeRecorder[] = [];
  const wakeLocks = { requested: 0, released: 0 };
  const deps: CaptureDeps = {
    getStream: async (asked) => {
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

test("at the per-file size limit the recording goes on in a new part, until the flow's file count runs out", async () => {
  const { capture, store, streams, recorders } = await setup();
  await capture.start(meeting, { maxBytes: 10, maxFiles: 2 });
  recorders[0].emit("abc");
  assert.equal(recorders.length, 1, "room for two more chunks like it");
  recorders[0].emit("def");
  await until(() => recorders.length === 2, "the second part");
  assert.equal(capture.getSnapshot().status, "recording");
  assert.equal(streams.length, 1, "the same microphone: no new permission, no silence to ask for it");
  assert.equal(streams[0].track.readyState, "live");
  assert.equal(capture.getSnapshot().error, null);

  recorders[1].emit("ghi");
  assert.equal(capture.getSnapshot().recordedBytes, 10, "the size shown counts every part");
  recorders[1].emit("jkl"); // the second part is full too, and the flow takes no third file
  await until(() => capture.getSnapshot().status === "stopped", "the stop");
  const files = await store.readParts(capture.getSnapshot().recording!.id);
  assert.deepEqual(await texts(files), ["abcdef.", "ghijkl."]);
  assert.ok(files.every((file) => file.blob.size <= 10));
  assert.equal(
    capture.getSnapshot().error,
    "Inspelningen stoppades vid flödets gräns på 2 filer om 10 B. Det som spelats in är sparat.",
  );
  assert.equal(streams[0].track.readyState, "ended");
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
  await capture.start(meeting, { maxBytes: 10 });
  recorders[0].emit("abc");
  recorders[0].emit("def");
  await until(() => capture.getSnapshot().status === "interrupted", "the pause");
  const paused = capture.getSnapshot().recording!;
  assert.equal(paused.state, "paused");
  assert.deepEqual(await texts(await store.readParts(paused.id)), ["abcdef."]);
});

test("a flow that takes one file stops the recording before the file grows too large to send", async () => {
  const { capture, store, recorders } = await setup();
  await capture.start(meeting, { maxBytes: 10, maxFiles: 1 });
  recorders[0].emit("abc");
  recorders[0].emit("def");
  await until(() => capture.getSnapshot().status === "stopped", "the stop");

  const [file] = await store.readParts(capture.getSnapshot().recording!.id);
  assert.equal(await file.blob.text(), "abcdef.");
  assert.equal(
    capture.getSnapshot().error,
    "Inspelningen stoppades vid flödets gräns på 10 B. Det som spelats in är sparat.",
  );
});

test("stopping or losing the microphone while a new part is being started wins over the new part", async () => {
  for (const [what, act] of [
    ["stop", (capture: RecordingCapture) => void capture.stop()],
    ["lost microphone", (_capture: RecordingCapture, stream: FakeStream) => stream.track.lose("mute")],
  ] as const) {
    const { capture, streams, recorders } = await setup();
    await capture.start(meeting, { maxBytes: 10 });
    recorders[0].emit("abc");
    recorders[0].emit("def"); // asks for a new part; the old one is still stopping
    act(capture, streams[0]);
    await until(() => ["stopped", "interrupted"].includes(capture.getSnapshot().status), what);
    await settle();
    assert.equal(recorders.length, 1, `${what}: no new part`);
    assert.equal(streams[0].track.readyState, "ended", `${what}: the microphone is let go`);
  }
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

  const stream = new FakeStream();
  const unsupported = new RecordingCapture(() => store, {
    getStream: async () => stream as unknown as MediaStream,
    createRecorder: () => {
      throw new DOMException("Unsupported MIME type", "NotSupportedError");
    },
  });
  await unsupported.start(meeting);
  assert.equal(unsupported.getSnapshot().status, "idle");
  assert.match(unsupported.getSnapshot().error ?? "", /kunde inte startas/);
  assert.equal(stream.track.readyState, "ended", "the microphone is let go");
  assert.deepEqual(await store.listUnsent("user-1"), []);
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
