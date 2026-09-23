import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";

import { fakeWebLocks } from "./fake-web-locks";
import {
  openRecordingStore,
  type NewRecording,
  type RecordingFile,
  type StoreEnv,
} from "./recording-store";

const MB = 1024 * 1024;

const meeting: NewRecording = {
  ownerId: "user-1",
  flowId: "flow-1",
  flowName: "Nämndmöte till rapport",
  stepId: "step-audio",
  inputMode: "record",
  mimeType: "audio/webm;codecs=opus",
};

function clock(start = 1_000) {
  let now = start;
  return () => (now += 1_000);
}

/** A fresh device: its own database, clock and web locks shared by its tabs. */
function device(extra: Partial<StoreEnv> = {}): StoreEnv {
  return {
    indexedDB: new IDBFactory(),
    keyRange: IDBKeyRange,
    locks: fakeWebLocks(),
    now: clock(),
    ...extra,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const texts = (files: RecordingFile[]) => Promise.all(files.map((file) => file.blob.text()));

test("chunks come back in arrival order, one audio file per part", async () => {
  const store = await openRecordingStore(device());
  assert.equal(store.persistent, true);
  const recording = await store.create(meeting);

  assert.equal(await store.startPart(recording.id), 0);
  // MediaRecorder events do not wait for the previous write.
  void store.append(recording.id, 0, new Blob(["hea"]), 2_000);
  void store.append(recording.id, 0, new Blob(["der+"]), 4_000);
  await store.append(recording.id, 0, new Blob(["one"]), 5_000);
  assert.equal(await store.startPart(recording.id), 1);
  await store.append(recording.id, 1, new Blob(["two"]), 1_500);
  // A part the tab died in before its first chunk is not a file.
  assert.equal(await store.startPart(recording.id), 2);

  const parts = await store.readParts(recording.id);
  assert.deepEqual(await texts(parts), ["header+one", "two"]);
  assert.deepEqual(
    parts.map((part) => [part.index, part.blob.type]),
    [
      [0, "audio/webm"],
      [1, "audio/webm"],
    ],
  );
  assert.match(parts[0].filename, /^inspelning-\d{4}-\d{2}-\d{2}-\d{4}-del-1\.webm$/);
  assert.match(parts[1].filename, /-del-2\.webm$/);
  const saved = await store.get(recording.id);
  assert.deepEqual(
    saved?.parts.map((part) => [part.index, part.chunks, part.bytes, part.durationMs]),
    [
      [0, 3, 10, 5_000],
      [1, 1, 3, 1_500],
      [2, 0, 0, 0],
    ],
  );
  assert.equal(saved?.durationMs, 6_500);
  assert.equal(saved?.state, "recording");
});

test("a recording cut off mid-meeting is listed as unsent when the app is opened again", async () => {
  const env = device();
  const tab = await openRecordingStore(env);
  const recording = await tab.create(meeting);
  await tab.startPart(recording.id);
  await tab.append(recording.id, 0, new Blob(["audio"]), 2_000);
  // The tab dies here (reload, crash, expired session): no stop, no state change,
  // and the browser ends the tab's lease.
  tab.release(recording.id);

  const reopened = await openRecordingStore(env);
  const unsent = await reopened.listUnsent("user-1");
  assert.deepEqual(
    unsent.map((r) => [r.id, r.flowName, r.durationMs, r.state]),
    [[recording.id, "Nämndmöte till rapport", 2_000, "recording"]],
  );
  assert.deepEqual(await texts(await reopened.readParts(recording.id)), ["audio"]);
});

test("unsent recordings are listed newest first, without those still leased or already sent", async () => {
  const store = await openRecordingStore(device());
  let changes = 0;
  store.subscribe(() => (changes += 1));

  const older = await store.create(meeting);
  await store.setState(older.id, "stopped");
  store.release(older.id);
  const recording = await store.create(meeting); // leased by the tab that records it
  const sent = await store.create(meeting);
  await store.accept(sent.id, "run-1");
  const newest = await store.create({ ...meeting, flowName: "Intervju" });
  store.release(newest.id);

  assert.deepEqual(
    (await store.listUnsent("user-1")).map((r) => r.id),
    [newest.id, older.id],
  );
  assert.ok(changes > 0, "lists showing recordings hear about changes");
  store.release(recording.id);
  await settle();
  assert.deepEqual(
    (await store.listUnsent("user-1")).map((r) => r.id),
    [newest.id, recording.id, older.id],
  );

  // Without Web Locks (Safari before 15.4) a tab still knows what it records itself.
  const withoutLocks = await openRecordingStore(device({ locks: undefined }));
  const own = await withoutLocks.create(meeting);
  assert.deepEqual(await withoutLocks.listUnsent("user-1"), []);
  assert.equal(await withoutLocks.lease(own.id), false, "nothing else in this tab may write it");
  withoutLocks.release(own.id);
  assert.equal((await withoutLocks.listUnsent("user-1")).length, 1);
});

test("an active lease hides a recording from recovery and keeps other tabs from writing it; an ended lease offers it again", async () => {
  const env = device();
  const recordingTab = await openRecordingStore(env);
  const otherTab = await openRecordingStore(env);
  const recording = await recordingTab.create(meeting);
  await recordingTab.startPart(recording.id);
  await recordingTab.append(recording.id, 0, new Blob(["audio"]), 2_000);

  assert.deepEqual(await otherTab.listUnsent("user-1"), [], "hidden while it is being recorded");
  assert.equal(await otherTab.lease(recording.id), false, "another tab cannot take it");
  await assert.rejects(otherTab.remove(recording.id), {
    message: "Inspelningen används i en annan flik.",
  });

  // Stopping ends the lease; so does the browser when the tab closes or crashes.
  recordingTab.release(recording.id);
  await settle();
  assert.deepEqual((await otherTab.listUnsent("user-1")).map((r) => r.id), [recording.id]);
  assert.equal(await otherTab.lease(recording.id), true);
  assert.equal(await recordingTab.lease(recording.id), false, "now the other tab has it");
  assert.deepEqual(await recordingTab.listUnsent("user-1"), []);
  assert.deepEqual(await texts(await otherTab.readParts(recording.id)), ["audio"]);
});

test("without Web Locks, only the tab that made a recording sends, continues or deletes it; other tabs save it as a file", async () => {
  // No Web Locks at all, or a browser that refuses them here.
  const refusing = {
    request: async () => {
      throw new DOMException("Web Locks are not allowed here", "SecurityError");
    },
    query: async () => ({ held: [], pending: [] }),
  } as unknown as StoreEnv["locks"];
  for (const locks of [undefined, refusing]) await onlyTheMakerChangesIt(device({ locks }));
});

async function onlyTheMakerChangesIt(env: StoreEnv) {
  const recordingTab = await openRecordingStore(env);
  const otherTab = await openRecordingStore(env);
  const recording = await recordingTab.create(meeting);
  await recordingTab.startPart(recording.id);
  await recordingTab.append(recording.id, 0, new Blob(["a"]), 1_000);
  await recordingTab.setState(recording.id, "stopped");
  recordingTab.release(recording.id); // Stoppa: the ready state in the tab that made it

  assert.equal(await otherTab.lease(recording.id), false, "nothing keeps the two tabs apart");
  await assert.rejects(otherTab.remove(recording.id), { message: "Inspelningen används i en annan flik." });
  assert.deepEqual(await texts(await otherTab.readParts(recording.id)), ["a"], "Spara som fil still reads it");
  assert.equal(await recordingTab.lease(recording.id), true, "the tab that made it sends or continues it");
  recordingTab.release(recording.id);

  // After a reload it is recovered, as a file only.
  const reloaded = await openRecordingStore(env);
  assert.deepEqual((await reloaded.listUnsent("user-1")).map((r) => r.id), [recording.id]);
  assert.equal(await reloaded.lease(recording.id), false);
}

test("the unsent list knows up front which recordings this tab may change", async () => {
  const withoutLocks = device({ locks: undefined });
  const made = await openRecordingStore(withoutLocks);
  const recording = await made.create(meeting);
  const other = await openRecordingStore(withoutLocks);
  assert.deepEqual([made.mayChange(recording.id), other.mayChange(recording.id)], [true, false]);
  const withLocks = await openRecordingStore(device());
  assert.equal(withLocks.mayChange(recording.id), true, "Web Locks keep the tabs apart");
});

test("a shared device offers each person only their own recordings, and 'Ta bort' removes one for good", async () => {
  const env = device();
  const store = await openRecordingStore(env);
  const mine = await store.create(meeting);
  const colleagues = await store.create({ ...meeting, ownerId: "user-2" });
  store.release(mine.id);
  store.release(colleagues.id);
  await settle();
  assert.deepEqual((await store.listUnsent("user-1")).map((r) => r.id), [mine.id]);
  assert.deepEqual((await store.listUnsent("user-2")).map((r) => r.id), [colleagues.id]);

  await store.startPart(mine.id);
  await store.append(mine.id, 0, new Blob(["audio"]), 1_000);
  await store.remove(mine.id);
  assert.deepEqual(await store.listUnsent("user-1"), []);
  assert.deepEqual(await (await openRecordingStore(env)).readParts(mine.id), []);
});

test("the local copy stays through every upload state and is deleted once Eneo accepted the run", async () => {
  const env = device();
  const store = await openRecordingStore(env);
  const recording = await store.create(meeting);
  await store.startPart(recording.id);
  await store.append(recording.id, 0, new Blob(["audio"]), 2_000);

  await store.setState(recording.id, "stopped");
  store.release(recording.id);
  await store.setState(recording.id, "uploading");
  await store.setPartFileId(recording.id, 0, "file-1");
  await store.setState(recording.id, "uploaded");
  assert.deepEqual(
    (await store.listUnsent("user-1")).map((r) => [r.state, r.parts[0].fileId]),
    [["uploaded", "file-1"]],
  );
  await store.clearFileIds(recording.id);
  assert.equal((await store.get(recording.id))?.parts[0].fileId, null);
  assert.deepEqual(await texts(await store.readParts(recording.id)), ["audio"]);

  await store.accept(recording.id, "run-1");
  assert.deepEqual(await store.listUnsent("user-1"), []);
  assert.equal(await store.get(recording.id), null);
  assert.deepEqual(await store.readParts(recording.id), []);
  const reopened = await openRecordingStore(env);
  assert.deepEqual(await reopened.listUnsent("user-1"), []);
  assert.deepEqual(await reopened.readParts(recording.id), []);
});

test("a sent recording whose local copy cannot be deleted is never offered again", async () => {
  const store = await openRecordingStore(device());
  const recording = await store.create(meeting);
  await store.startPart(recording.id);
  await store.append(recording.id, 0, new Blob(["audio"]), 2_000);

  const remove = IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.delete = function () {
    throw new DOMException("Connection to Indexed Database server lost", "UnknownError");
  };
  try {
    await store.accept(recording.id, "run-1");
  } finally {
    IDBObjectStore.prototype.delete = remove;
  }
  assert.deepEqual(await store.listUnsent("user-1"), []);
});

test("chunks of a recording being captured are stored even when reading the database fails", async () => {
  for (const env of [device(), device({ locks: undefined })]) await keepsChunksWhenReadsFail(env);
});

async function keepsChunksWhenReadsFail(env: StoreEnv) {
  const store = await openRecordingStore(env);
  const recording = await store.create(meeting); // leased: this tab records it
  await store.startPart(recording.id);

  const get = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function () {
    throw new DOMException("Connection to Indexed Database server lost", "UnknownError");
  };
  try {
    await store.append(recording.id, 0, new Blob(["a"]), 1_000);
    await store.append(recording.id, 0, new Blob(["b"]), 2_000);
  } finally {
    IDBObjectStore.prototype.get = get;
  }
  assert.deepEqual(await texts(await store.readParts(recording.id)), ["ab"], env.locks ? "Web Locks" : "no Web Locks");
}

test("without IndexedDB the recording lives only in this tab, and the store says so", async () => {
  const throwsOnOpen = {
    open() {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
  } as unknown as IDBFactory;
  const failsToOpen = {
    open() {
      const request = {} as IDBOpenDBRequest;
      setImmediate(() => request.onerror?.(new Event("error")));
      return request;
    },
  } as unknown as IDBFactory;

  for (const env of [{}, { indexedDB: throwsOnOpen, keyRange: IDBKeyRange }, { indexedDB: failsToOpen, keyRange: IDBKeyRange }]) {
    const store = await openRecordingStore(env);
    assert.equal(store.persistent, false);
    const recording = await store.create(meeting);
    await store.startPart(recording.id);
    void store.append(recording.id, 0, new Blob(["a"]), 1_000);
    await store.append(recording.id, 0, new Blob(["b"]), 2_000);
    assert.deepEqual(await texts(await store.readParts(recording.id)), ["ab"]);
    store.release(recording.id);
    assert.equal((await store.listUnsent("user-1")).length, 1);
    assert.equal((await (await openRecordingStore(env)).listUnsent("user-1")).length, 0);
  }
});

test("a chunk the device refuses stays in this tab, in order, and the store stops claiming persistence", async () => {
  const store = await openRecordingStore(device());
  const recording = await store.create(meeting);
  await store.startPart(recording.id);
  await store.append(recording.id, 0, new Blob(["a"]), 1_000);

  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
    if (this.name === "chunks") throw new DOMException("Disk full", "QuotaExceededError");
    return put.apply(this, args);
  };
  try {
    await store.append(recording.id, 0, new Blob(["b"]), 2_000);
  } finally {
    IDBObjectStore.prototype.put = put;
  }
  await store.append(recording.id, 0, new Blob(["c"]), 3_000);

  assert.equal(store.persistent, false);
  assert.deepEqual(await texts(await store.readParts(recording.id)), ["abc"]);
  assert.equal((await store.get(recording.id))?.parts[0].bytes, 3);
});

test("audio only this tab has keeps the recording from other tabs after Stoppa, until this tab sends or deletes it", async () => {
  const env = device();
  const recordingTab = await openRecordingStore(env);
  const otherTab = await openRecordingStore(env);
  const recording = await recordingTab.create(meeting);
  await recordingTab.startPart(recording.id);
  await recordingTab.append(recording.id, 0, new Blob(["prefix"]), 1_000);
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
    if (this.name === "chunks") throw new DOMException("Disk full", "QuotaExceededError");
    return put.apply(this, args);
  };
  try {
    await recordingTab.append(recording.id, 0, new Blob(["suffix"]), 2_000);
  } finally {
    IDBObjectStore.prototype.put = put;
  }
  await recordingTab.setState(recording.id, "stopped");
  recordingTab.release(recording.id); // Stoppa
  await settle();

  assert.equal(await otherTab.lease(recording.id), false, "no other tab sends or deletes it without the suffix");
  assert.deepEqual(await otherTab.listUnsent("user-1"), []);
  assert.deepEqual((await recordingTab.listUnsent("user-1")).map((r) => r.id), [recording.id], "this tab still offers it");

  // This tab's send takes it over, and sends all of it.
  assert.equal(await recordingTab.lease(recording.id), true);
  assert.equal(await recordingTab.lease(recording.id), false, "one operation at a time");
  assert.deepEqual(await texts(await recordingTab.readParts(recording.id)), ["prefixsuffix"]);
  recordingTab.release(recording.id); // that send failed: the suffix is still only here
  await settle();
  assert.equal(await otherTab.lease(recording.id), false);

  assert.equal(await recordingTab.lease(recording.id), true);
  await recordingTab.accept(recording.id, "run-1");
  recordingTab.release(recording.id);
  await settle();
  assert.equal(await otherTab.lease(recording.id), true, "sent: nothing is held any more");
});

test("recording asks for persistent storage and warns when little space is left", async () => {
  let persistCalls = 0;
  const storage = (usage: number): NonNullable<StoreEnv["storage"]> => ({
    persist: async () => {
      persistCalls += 1;
      return true;
    },
    estimate: async () => ({ usage, quota: 1_000 * MB }),
  });

  const tight = await openRecordingStore(device({ storage: storage(950 * MB) }));
  assert.equal(await tight.lowOnSpace(), true);
  const roomy = await openRecordingStore(device({ storage: storage(100 * MB) }));
  assert.equal(await roomy.lowOnSpace(), false);
  assert.equal(await (await openRecordingStore(device())).lowOnSpace(), false);

  await tight.requestPersistence();
  assert.equal(persistCalls, 1);
});
