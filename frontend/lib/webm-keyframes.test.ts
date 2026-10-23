import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";

import { openRecordingStore, type NewRecording } from "./recording-store";
import { keyframeMarker, markKeyframes, withKeyframes } from "./webm-keyframes";

const hex = (text: string) => Uint8Array.from(text.match(/../g) ?? [], (byte) => parseInt(byte, 16));

// The first bytes Safari's MediaRecorder wrote for audio/webm;codecs=opus (2026-10-13), up to its first Cluster: the
// EBML header, a Segment of unknown size, an empty SeekHead, Info (MuxingApp and WritingApp "LibWebM-0.0.1", the
// Duration the store writes) and Tracks, with the audio as track 2.
const SAFARI_HEADER =
  "1a45dfa3010000000000001f4286810142f7810142f2810442f381084282847765626d42878102428581021853806701ffffffffffffff" +
  "114d9b7401000000000000001549a96601000000000000492ad7b1830f424044898840be0400000000004d809851546d7578696e67417070" +
  "4c69625765624d2d302e302e31574199515477726974696e674170704c69625765624d2d302e302e311654ae6b0100000000000060ae01" +
  "00000000000057d7810273c584b52c8b2683810256aa8400632ea056bb8404c4b4008686415f4f50555363a2934f70757348656164010138" +
  "0180bb0000000000258688844f505553e1010000000000000db58840e77000000000009f8101";
/** A Cluster of unknown size, as Safari writes it, starting at `timecode` (hex). */
const cluster = (timecode: string) => "1f43b67501ffffffffffffff" + "e7" + (0x80 | (timecode.length / 2)).toString(16) + timecode;
/** A SimpleBlock as Safari writes it: a four-byte size, track 2, timecode, `flags` (hex), four bytes of audio. */
const block = (timecode: string, flags = "00") => "a3" + "10000008" + "82" + timecode + flags + "fcfffe00";
const safariWebm = () =>
  hex(SAFARI_HEADER + cluster("06") + block("0000") + block("0014") + block("0028", "06") + cluster("03ee") + block("0000") + block("0014"));
/** Where the five blocks keep their flags. */
const FLAGS = (() => {
  const bytes = safariWebm();
  const at: number[] = [];
  for (let i = 0; i < bytes.length - 8; i++) if (bytes[i] === 0xa3 && bytes[i + 1] === 0x10 && bytes[i + 5] === 0x82) at.push(i + 8);
  return at;
})();

// Chrome's first bytes (lib/webm-duration.test.ts): its blocks carry the flag already.
const CHROME_WEBM = hex(
  "1a45dfa39f4286810142f7810142f2810442f381084282847765626d42878104428581021853806701ffffffffffffff" +
    "1549a966992ad7b1830f42404d80864368726f6d655741864368726f6d65" +
    "1654ae6bbfaebdd7810173c587a04f6d0808643a8381028686415f4f50555363a2934f707573486561640101000080bb0000000000e18db584473b80009f810162648120" +
    "1f43b67501ffffffffffffffe78100a38c81000080fb03ff",
);

/** `bytes` cut at each of `at`, as the recorder's chunks would come. */
const cut = (bytes: Uint8Array, at: number[]) => [0, ...at, bytes.length].slice(1).map((end, i, ends) => bytes.slice(i ? ends[i - 1] : 0, end));
const joined = (chunks: Uint8Array[]) => new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
const asBytes = async (chunks: (Blob | ArrayBuffer | Uint8Array)[]) =>
  new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer());

test("every block of a Safari part becomes a keyframe, other flags kept, and no other byte changes", () => {
  const before = safariWebm();
  const after = safariWebm();
  assert.equal(FLAGS.length, 5);
  assert.equal(markKeyframes([after]), 5);
  assert.deepEqual(FLAGS.map((at) => after[at]), [0x80, 0x80, 0x86, 0x80, 0x80], "the lacing bits of the third stay");
  for (let i = 0; i < before.length; i++) if (!FLAGS.includes(i)) assert.equal(after[i], before[i], `byte ${i}`);
  assert.equal(markKeyframes([after]), 0, "a marked part has nothing left to mark");
});

test("chunks may cut the file anywhere: in an element's id, its size, a block's track or its flags", () => {
  const whole = safariWebm();
  markKeyframes([whole]);
  for (let at = 1; at < whole.length; at++) {
    const chunks = cut(safariWebm(), [at]);
    markKeyframes(chunks);
    assert.deepEqual(joined(chunks), whole, `cut at ${at}`);
  }
  const bytes = cut(safariWebm(), [...safariWebm().keys()].slice(1));
  markKeyframes(bytes);
  assert.deepEqual(joined(bytes), whole, "one byte a chunk");
});

test("a part cut off inside a block keeps the blocks before it marked", () => {
  const chunks = [safariWebm().slice(0, FLAGS[3] - 2)];
  assert.equal(markKeyframes(chunks), 3);
});

test("a Safari part's chunks come back marked, from blobs and from bytes, and the store's own bytes stay as they were", async () => {
  const [first, second] = cut(safariWebm(), [FLAGS[1] - 3]);
  const held = second.slice();
  const marked = await withKeyframes([new Blob([first]), held], "audio/webm;codecs=opus");
  const bytes = await asBytes(marked);
  assert.deepEqual(FLAGS.map((at) => bytes[at] & 0x80), [0x80, 0x80, 0x80, 0x80, 0x80]);
  assert.deepEqual(held, second, "the chunk held in memory is copied, not changed");
});

test("a part that flags its blocks, another format, a file this does not know and an unread chunk stay as they were", async (t) => {
  const chrome = [new Blob([CHROME_WEBM]), new Blob([hex("a38c81000080fb03ff")])];
  const asGiven = await withKeyframes(chrome, "audio/webm");
  assert.ok(asGiven.every((chunk, i) => chunk === chrome[i]), "Chrome's part, the very chunks");

  const safari = [safariWebm()];
  assert.equal((await withKeyframes(safari, "audio/mp4"))[0], safari[0], "MP4");
  const noise = [hex("00112233445566778899")];
  assert.equal((await withKeyframes(noise, "audio/webm"))[0], noise[0], "not WebM");

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stuck = new Blob([safariWebm()]);
  stuck.arrayBuffer = () => new Promise(() => {});
  const waiting = withKeyframes([stuck], "audio/webm");
  t.mock.timers.tick(2_000);
  assert.equal((await waiting)[0], stuck, "a chunk that does not come in time");
});

const meeting: NewRecording = {
  ownerId: "user-1",
  flowId: "flow-1",
  flowName: "Möte",
  stepId: "step-audio",
  inputMode: "record",
  mimeType: "audio/webm;codecs=opus",
};

test("a Safari part leaves the device with every block a keyframe", async () => {
  for (const env of [{}, { indexedDB: new IDBFactory(), keyRange: IDBKeyRange }]) {
    const store = await openRecordingStore(env);
    const recording = await store.create(meeting);
    await store.startPart(recording.id);
    const [first, second] = cut(safariWebm(), [FLAGS[2] + 1]);
    await store.append(recording.id, 0, new Blob([first]), 2_000);
    await store.append(recording.id, 0, new Blob([second]), 3_000);
    const [file] = await store.readParts(recording.id);
    const bytes = new Uint8Array(await file.blob.arrayBuffer());
    const blocks = [...bytes.keys()].filter((i) => bytes[i] === 0xa3 && bytes[i + 1] === 0x10 && bytes[i + 5] === 0x82);
    assert.equal(blocks.length, 5);
    assert.ok(blocks.every((i) => bytes[i + 8] & 0x80), "every block flagged");
  }
});

test("marked as the chunks come, a batch at a time, a part's bytes are those of marking it whole, wherever the chunks and batches are cut", async () => {
  const whole = safariWebm();
  markKeyframes([whole]);
  // One byte a chunk cuts every element everywhere; a batch of one to five of them cuts the walk between any two bytes.
  for (const size of [1, 2, 3, 5]) {
    const chunks = cut(safariWebm(), [...safariWebm().keys()].slice(1));
    const mark = keyframeMarker("audio/webm;codecs=opus");
    const out: (Blob | ArrayBuffer | Uint8Array)[] = [];
    for (let at = 0; at < chunks.length; at += size) out.push(...(await mark(chunks.slice(at, at + size))));
    out.push(...(await mark([], true)));
    assert.deepEqual(await asBytes(out), whole, `batches of ${size}`);
  }
});

test("a Safari part of hours is read from the device a batch at a time, every block a keyframe, and never whole", async () => {
  const store = await openRecordingStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange });
  const recording = await store.create(meeting);
  await store.startPart(recording.id);
  // The header and its first Cluster, then 600 chunks of a block each.
  const blocks = Array.from({ length: 600 }, (_, i) => block((i % 256).toString(16).padStart(2, "0") + "00"));
  await store.append(recording.id, 0, new Blob([hex(SAFARI_HEADER + cluster("06"))]), 2_000);
  for (const [i, each] of blocks.entries()) await store.append(recording.id, 0, new Blob([hex(each)]), 2_000 * (i + 2));
  const getAll = IDBObjectStore.prototype.getAll;
  const reads: number[] = [];
  IDBObjectStore.prototype.getAll = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["getAll"]>) {
    const request = getAll.apply(this, args);
    if (this.name === "chunks") request.addEventListener("success", () => reads.push((request.result as unknown[]).length));
    return request;
  };
  let bytes: Uint8Array;
  try {
    const [file] = await store.readParts(recording.id);
    bytes = new Uint8Array(await file.blob.arrayBuffer());
  } finally {
    IDBObjectStore.prototype.getAll = getAll;
  }
  const flags = [...bytes.keys()].filter((i) => bytes[i] === 0xa3 && bytes[i + 1] === 0x10 && bytes[i + 5] === 0x82).map((i) => bytes[i + 8]);
  assert.equal(flags.length, 600);
  assert.ok(flags.every((flag) => flag & 0x80), "every block flagged");
  assert.ok(Math.max(...reads) < 601, `read in batches, never whole: ${reads.join(", ")}`);
});
