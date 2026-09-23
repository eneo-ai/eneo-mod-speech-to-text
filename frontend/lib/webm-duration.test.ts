import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import { openRecordingStore, type NewRecording } from "./recording-store";
import { withWebmDuration } from "./webm-duration";

const hex = (text: string) => Uint8Array.from(text.match(/../g) ?? [], (byte) => parseInt(byte, 16));

// The first bytes Chrome 153's MediaRecorder wrote for audio/webm;codecs=opus,
// mono, 32 kbit/s: the EBML header, a Segment of unknown size, Info
// (TimecodeScale 1 ms, MuxingApp and WritingApp "Chrome", no Duration) and
// Tracks, then the start of the first Cluster.
const EBML_HEADER = "1a45dfa39f4286810142f7810142f2810442f381084282847765626d42878104428581";
const SEGMENT_UNKNOWN_SIZE = "021853806701ffffffffffffff";
const CHROME_INFO = "1549a966992ad7b1830f42404d80864368726f6d655741864368726f6d65";
const CHROME_TRACKS =
  "1654ae6bbfaebdd7810173c587a04f6d0808643a8381028686415f4f50555363a2934f707573486561640101000080bb0000000000e18db584473b80009f810162648120";
const CLUSTER_START = "1f43b67501ffffffffffffffe78100a38c81000080fb03ff";
const chromeWebm = () =>
  hex(EBML_HEADER + SEGMENT_UNKNOWN_SIZE + CHROME_INFO + CHROME_TRACKS + CLUSTER_START);

/** One EBML element with a one-byte size (data under 127 bytes). */
const element = (id: string, data: string) =>
  id + (0x80 | (data.length / 2)).toString(16).padStart(2, "0") + data;

/**
 * Reads Segment > Info the way a player does, independently of the code under
 * test: the Duration in milliseconds, or null when the file has none.
 */
function readDurationMs(bytes: Uint8Array): number | null {
  const width = (first: number) => Math.clz32(first) - 23;
  const at = (start: number) => {
    const idWidth = width(bytes[start]);
    const sizeWidth = width(bytes[start + idWidth]);
    const sizeBytes = [...bytes.subarray(start + idWidth, start + idWidth + sizeWidth)];
    const unknown =
      sizeBytes[0] === 0xff >> (sizeWidth - 1) && sizeBytes.slice(1).every((b) => b === 0xff);
    return {
      id: [...bytes.subarray(start, start + idWidth)].reduce((n, b) => n * 256 + b, 0),
      data: start + idWidth + sizeWidth,
      size: unknown
        ? Infinity
        : sizeBytes.reduce((n, b, i) => n * 256 + (i === 0 ? b & (0xff >> sizeWidth) : b), 0),
    };
  };
  const header = at(0);
  const segment = at(header.data + header.size);
  if (segment.id !== 0x18538067) return null;
  for (let child = at(segment.data); child.id !== 0x1f43b675; child = at(child.data + child.size)) {
    if (child.id !== 0x1549a966) continue;
    let scale = 1_000_000;
    let duration: number | null = null;
    for (let field = at(child.data); field.data < child.data + child.size; field = at(field.data + field.size)) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + field.data, field.size);
      if (field.id === 0x2ad7b1) scale = [...bytes.subarray(field.data, field.data + field.size)].reduce((n, b) => n * 256 + b, 0);
      if (field.id === 0x4489) duration = field.size === 8 ? view.getFloat64(0) : view.getFloat32(0);
    }
    return duration === null ? null : (duration * scale) / 1_000_000;
  }
  return null;
}

test("Chrome's WebM gets the recorded duration in its header, and the audio after it is left alone", () => {
  const original = chromeWebm();
  assert.equal(readDurationMs(original), null, "Chrome writes no Duration");

  const patched = withWebmDuration(original, 5_000);
  assert.ok(patched);
  assert.equal(readDurationMs(patched), 5_000);
  const untilInfo = hex(EBML_HEADER + SEGMENT_UNKNOWN_SIZE);
  assert.deepEqual(patched.subarray(0, untilInfo.length), untilInfo, "the Segment keeps its unknown size");
  const audio = hex(CHROME_TRACKS + CLUSTER_START);
  assert.deepEqual(patched.subarray(patched.length - audio.length), audio);
  assert.deepEqual(readDurationMs(withWebmDuration(original, 2 * 60 * 60 * 1_000)!), 7_200_000);
});

test("an existing Duration is replaced in place, in the file's own time scale", () => {
  const microsecondTicks = element("2ad7b1", "0186a0"); // TimecodeScale 100 000 ns
  for (const zero of ["0000000000000000", "00000000"]) {
    const original = hex(
      EBML_HEADER + SEGMENT_UNKNOWN_SIZE + element("1549a966", microsecondTicks + element("4489", zero)) + CLUSTER_START,
    );
    const patched = withWebmDuration(original, 5_000);
    assert.ok(patched);
    assert.equal(patched.length, original.length);
    assert.equal(readDurationMs(patched), 5_000);
    const at = patched.length - hex(CLUSTER_START).length - zero.length / 2;
    const view = new DataView(patched.buffer);
    assert.equal(zero.length === 16 ? view.getFloat64(at) : view.getFloat32(at), 50_000, "5 s in 100 µs ticks");
  }
});

test("a Segment of known size grows with its Info", () => {
  const body = hex(CHROME_INFO + CHROME_TRACKS + CLUSTER_START);
  const size = "01" + body.length.toString(16).padStart(14, "0");
  const original = hex(EBML_HEADER + "02" + "18538067" + size + CHROME_INFO + CHROME_TRACKS + CLUSTER_START);
  const patched = withWebmDuration(original, 1_500);
  assert.ok(patched);
  assert.equal(readDurationMs(patched), 1_500);
  const segmentData = EBML_HEADER.length / 2 + 1 + 4 + 8;
  const view = new DataView(patched.buffer);
  const segmentSize = Number(view.getBigUint64(segmentData - 8) & 0x00ffffffffffffffn);
  assert.equal(segmentSize, patched.length - segmentData);

  // A part's first chunk holds only the start of its Segment.
  const firstChunk = original.subarray(0, original.length - hex(CLUSTER_START).length);
  const patchedChunk = withWebmDuration(firstChunk, 1_500);
  assert.ok(patchedChunk);
  assert.equal(readDurationMs(patchedChunk), 1_500);
});

test("files it does not recognise come back unchanged", () => {
  const seekHeadFirst = hex(
    EBML_HEADER + SEGMENT_UNKNOWN_SIZE + element("114d9b74", "4dbb8b53ab841549a96653ac8100") + CHROME_INFO + CLUSTER_START,
  );
  assert.equal(withWebmDuration(seekHeadFirst, 1_000), null, "a SeekHead would point past moved bytes");
  assert.equal(withWebmDuration(hex("0000001c6674797069736f6d"), 1_000), null, "MP4");
  assert.equal(withWebmDuration(chromeWebm().subarray(0, 60), 1_000), null, "cut off inside Info");
  assert.equal(withWebmDuration(new Uint8Array(), 1_000), null);
});

test("every prefix of Chrome's first bytes gets Duration only once its whole Info is there, and nothing throws", () => {
  const whole = chromeWebm();
  const infoEnd = hex(EBML_HEADER + SEGMENT_UNKNOWN_SIZE + CHROME_INFO).length;
  for (let length = 0; length <= whole.length; length += 1) {
    const prefix = whole.subarray(0, length);
    const patched = withWebmDuration(prefix, 5_000);
    if (length < infoEnd) {
      assert.equal(patched, null, `cut off at byte ${length}`);
      continue;
    }
    assert.ok(patched, `whole Info at byte ${length}`);
    assert.equal(readDurationMs(patched), 5_000, `at byte ${length}`);
    assert.deepEqual(patched.subarray(patched.length - (length - infoEnd)), prefix.subarray(infoEnd), `the rest at byte ${length}`);
  }
});

test("fields that run past their Info, or that no player could read, give null instead of an error", () => {
  const info = (fields: string) => hex(EBML_HEADER + SEGMENT_UNKNOWN_SIZE + element("1549a966", fields));
  const cases: Array<[string, Uint8Array]> = [
    ["a Duration longer than its Info", hex(EBML_HEADER + SEGMENT_UNKNOWN_SIZE + element("1549a966", element("2ad7b1", "0f4240") + "448988" + "00000000") + CLUSTER_START)],
    ["a TimecodeScale of nine bytes", info(element("2ad7b1", "000000000000000f42") + element("4489", "00000000"))],
    ["a TimecodeScale of zero", info(element("2ad7b1", "00"))],
    ["a field longer than the file", info(element("2ad7b1", "0f4240") + "4d8001ffffffffffff00")],
    ["an Info size cut in half", hex(EBML_HEADER + SEGMENT_UNKNOWN_SIZE + "1549a966" + "40")],
  ];
  for (const [what, bytes] of cases) {
    assert.equal(withWebmDuration(bytes, 1_000), null, what);
  }
});

const meeting: NewRecording = {
  ownerId: "user-1",
  flowId: "flow-1",
  flowName: "Nämndmöte till rapport",
  stepId: "step-audio",
  inputMode: "record",
  mimeType: "audio/webm;codecs=opus",
};

test("an assembled WebM part reports its recorded duration; MP4 parts stay as recorded", async () => {
  for (const env of [{}, { indexedDB: new IDBFactory(), keyRange: IDBKeyRange }]) {
    const store = await openRecordingStore(env);
    const webm = await store.create(meeting);
    await store.startPart(webm.id);
    await store.append(webm.id, 0, new Blob([chromeWebm()]), 2_000);
    await store.append(webm.id, 0, new Blob([hex("a38c81000080fb03fffefffefffe")]), 4_321);
    const [file] = await store.readParts(webm.id);
    assert.equal(readDurationMs(new Uint8Array(await file.blob.arrayBuffer())), 4_321);
    assert.equal((await store.get(webm.id))?.parts[0].durationMs, 4_321, "the store keeps it for the UI");

    const mp4 = await store.create({ ...meeting, mimeType: "audio/mp4" });
    const recorded = hex("0000001c6674797069736f6d0000020069736f6d69736f32");
    await store.startPart(mp4.id);
    await store.append(mp4.id, 0, new Blob([recorded]), 1_000);
    const [mp4File] = await store.readParts(mp4.id);
    assert.deepEqual(new Uint8Array(await mp4File.blob.arrayBuffer()), recorded);
  }
});
