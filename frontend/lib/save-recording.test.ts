import assert from "node:assert/strict";
import test from "node:test";
import { crc32 as nodeCrc32 } from "node:zlib";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import { fakeWebLocks } from "./fake-web-locks";
import { NOT_ON_DEVICE, openRecordingStore } from "./recording-store";
import { installDom } from "./test-dom";
import { unzippedText } from "./test-zip";
import { crc32, zipFiles } from "./zip";

// The download is an anchor's click.
installDom();

/** The downloads a test starts: each anchor's name and the Blob its address stands for. */
function downloads(t: { after: (fn: () => void) => void }) {
  const started: Array<{ name: string; blob: Blob }> = [];
  const blobs = new Map<string, Blob>();
  const { createObjectURL } = URL;
  const { click } = HTMLAnchorElement.prototype;
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:${blobs.size}`;
    blobs.set(url, blob);
    return url;
  };
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    started.push({ name: this.download, blob: blobs.get(this.href)! });
  };
  t.after(() => {
    URL.createObjectURL = createObjectURL;
    HTMLAnchorElement.prototype.click = click;
  });
  return started;
}

async function recordingOf(parts: string[]) {
  const store = await openRecordingStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, locks: fakeWebLocks() });
  const recording = await store.create({
    ownerId: "user-1",
    flowId: "flow-1",
    flowName: "Nämndmöte till rapport",
    stepId: "step-audio",
    inputMode: "record",
    mimeType: "audio/webm;codecs=opus",
  });
  for (const text of parts) await store.append(recording.id, await store.startPart(recording.id), new Blob([text]), 1_000);
  return { store, recording };
}

test("the checksum is the zip format's CRC-32", () => {
  for (const text of ["", "123456789", "Nämndmöte", "x".repeat(70_000)]) {
    const bytes = new TextEncoder().encode(text);
    assert.equal(crc32(bytes), nodeCrc32(bytes), text.slice(0, 12));
  }
});

test("a zip of files is read back whole by unzip, Swedish names included", async () => {
  const zip = await zipFiles([
    { filename: "Nämndmöte-del-1.webm", blob: new Blob(["första delen"]) },
    { filename: "Nämndmöte-del-2.webm", blob: new Blob(["andra"]) },
    { filename: "tom.webm", blob: new Blob([]) },
    { filename: "../ut\\ur/mappen.webm", blob: new Blob(["x"]) },
  ]);
  assert.equal(zip.type, "application/zip");
  assert.deepEqual(await unzippedText(zip), [
    ["Nämndmöte-del-1.webm", "första delen"],
    ["Nämndmöte-del-2.webm", "andra"],
    ["tom.webm", ""],
    ["..-ut-ur-mappen.webm", "x"],
  ], "a name is never a path");
});

test("Spara ljudfil on a recording that is gone from the device says so instead of doing nothing", async () => {
  const { saveRecording } = await import("../components/save-recording");
  await assert.rejects(saveRecording("gone", async () => ({ readParts: async () => [] })), { message: NOT_ON_DEVICE });
});

test("Spara ljudfil saves a recording of one file as that file", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); // the download's address is let go a minute later
  const started = downloads(t);
  const { saveRecording } = await import("../components/save-recording");
  const { store, recording } = await recordingOf(["a"]);
  await saveRecording(recording.id, async () => store);
  assert.equal(started.length, 1);
  assert.match(started[0].name, /^inspelning-\d{4}-\d{2}-\d{2}-\d{4}\.webm$/);
  assert.equal(await started[0].blob.text(), "a");
});

test("Spara ljudfil saves every part of a recording in one press, as one zip named after the recording", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const started = downloads(t);
  const { saveRecording } = await import("../components/save-recording");
  const { store, recording } = await recordingOf(["a", "b", "c"]);
  await saveRecording(recording.id, async () => store);
  assert.equal(started.length, 1, "one download for the press");
  const [{ name, blob }] = started;
  const stamp = name.replace(/^inspelning-(.+)\.zip$/, "$1");
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}-\d{4}$/);
  assert.deepEqual(await unzippedText(blob), [
    [`inspelning-${stamp}-del-1.webm`, "a"],
    [`inspelning-${stamp}-del-2.webm`, "b"],
    [`inspelning-${stamp}-del-3.webm`, "c"],
  ]);
});

test("a failed database read fails the save, and saves nothing", async (t) => {
  const started = downloads(t);
  const { saveRecording } = await import("../components/save-recording");
  const store = { readParts: async () => Promise.reject(new Error("database unavailable")) };
  await assert.rejects(saveRecording("rec", async () => store), /database unavailable/);
  assert.deepEqual(started, []);
});
