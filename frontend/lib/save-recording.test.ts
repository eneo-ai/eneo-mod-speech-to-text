import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";

import { fakeWebLocks } from "./fake-web-locks";
import { NOT_ON_DEVICE, openRecordingStore } from "./recording-store";
import { installDom } from "./test-dom";

// The download is an anchor's click.
installDom();

test("Spara ljudfil on a recording that is gone from the device says so instead of doing nothing", async () => {
  const { saveRecordingFile } = await import("../components/save-recording");
  await assert.rejects(
    saveRecordingFile("gone", 0, async () => ({ readFile: async () => null })),
    { message: NOT_ON_DEVICE },
  );
});

test("Spara ljudfil reads only the file it saves: one part of the recording, not every part again for each press", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); // the download's address is let go a minute later
  const { saveRecordingFile } = await import("../components/save-recording");
  const store = await openRecordingStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, locks: fakeWebLocks() });
  const recording = await store.create({
    ownerId: "user-1",
    flowId: "flow-1",
    flowName: "Nämndmöte till rapport",
    stepId: "step-audio",
    inputMode: "record",
    mimeType: "audio/webm;codecs=opus",
  });
  for (const text of ["a", "b", "c"]) await store.append(recording.id, await store.startPart(recording.id), new Blob([text]), 1_000);

  const downloads: Array<{ name: string; blob: Blob }> = [];
  const blobs = new Map<string, Blob>();
  const { createObjectURL } = URL;
  const { click } = HTMLAnchorElement.prototype;
  const { getAll } = IDBObjectStore.prototype;
  let reads = 0;
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:${blobs.size}`;
    blobs.set(url, blob);
    return url;
  };
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, blob: blobs.get(this.href)! });
  };
  IDBObjectStore.prototype.getAll = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["getAll"]>) {
    if (this.name === "chunks") reads += 1;
    return getAll.apply(this, args);
  };
  try {
    await saveRecordingFile(recording.id, 1, async () => store);
  } finally {
    URL.createObjectURL = createObjectURL;
    HTMLAnchorElement.prototype.click = click;
    IDBObjectStore.prototype.getAll = getAll;
  }
  assert.equal(reads, 1, "the second part's audio alone is read");
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].name, /-del-2\.webm$/);
  assert.equal(await downloads[0].blob.text(), "b");
});

test("export skips a confirmed missing part, but never skips a failed database read", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { saveRecordingFile } = await import("../components/save-recording");
  const reads: number[] = [];
  const store = { readFile: async (_id: string, nth: number) => {
    reads.push(nth);
    return nth === 0 ? null : { index: 1, blob: new Blob(["surviving audio"]), filename: "part-2.webm" };
  } };
  assert.equal(await saveRecordingFile("rec", 0, async () => store, 3), 2, "the next press begins after the surviving part");
  assert.deepEqual(reads, [0, 1]);
  reads.length = 0;
  store.readFile = async (_id, nth) => { reads.push(nth); throw new Error("database unavailable"); };
  await assert.rejects(saveRecordingFile("rec", 0, async () => store, 3), /database unavailable/);
  assert.deepEqual(reads, [0], "retry stays at the failed read");
});
