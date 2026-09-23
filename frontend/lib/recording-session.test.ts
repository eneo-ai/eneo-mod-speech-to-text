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
  constructor(
    readonly stream: FakeStream,
    readonly mimeType: string,
  ) {
    super();
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

async function setup(options: { store?: RecordingStore; page?: PageLike } = {}) {
  const store = options.store ?? (await openRecordingStore({}));
  const streams: FakeStream[] = [];
  const recorders: FakeRecorder[] = [];
  const wakeLocks = { requested: 0, released: 0 };
  const deps: CaptureDeps = {
    getStream: async () => {
      const stream = new FakeStream();
      streams.push(stream);
      return stream as unknown as MediaStream;
    },
    createRecorder: (stream, mimeType) => {
      const recorder = new FakeRecorder(stream as unknown as FakeStream, mimeType);
      recorders.push(recorder);
      return recorder as unknown as MediaRecorder;
    },
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
  return { capture: new RecordingCapture(() => store, deps), store, streams, recorders, wakeLocks };
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

test("the recording stops before a part grows too large to send, and keeps what it has", async () => {
  const { capture, store, recorders } = await setup();
  await capture.start(meeting, { maxBytes: 10 });
  recorders[0].emit("abc");
  assert.equal(capture.getSnapshot().status, "recording", "room for two more chunks like it");
  recorders[0].emit("def");
  await until(() => capture.getSnapshot().status === "stopped", "the stop");

  const [file] = await store.readParts(capture.getSnapshot().recording!.id);
  assert.equal(await file.blob.text(), "abcdef.");
  assert.ok(file.blob.size <= 10);
  assert.match(capture.getSnapshot().error ?? "", /gräns/);
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
