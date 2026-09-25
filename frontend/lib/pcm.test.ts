import assert from "node:assert/strict";
import test from "node:test";

import { Pcm16Encoder } from "./pcm";

function encode(inputRate: number, blocks: Float32Array[]) {
  const frames: ArrayBuffer[] = [];
  const encoder = new Pcm16Encoder(inputRate, (frame) => frames.push(frame));
  for (const block of blocks) encoder.push(block);
  return { frames, encoder };
}

const samples = (frame: ArrayBuffer) => {
  const view = new DataView(frame);
  return Array.from({ length: frame.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true));
};

test("100 ms of 48 kHz audio becomes one 16 kHz frame of 3200 bytes, PCM16 little-endian", () => {
  const { frames } = encode(48_000, [new Float32Array(4_800).fill(0.5)]);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].byteLength, 3_200);
  assert.ok(samples(frames[0]).every((value) => value === 16_384), "0.5 of full scale");
  assert.deepEqual([...new Uint8Array(frames[0], 0, 2)], [0x00, 0x40], "low byte first");
});

test("audio arriving in the worklet's small blocks encodes the same as one block", () => {
  const signal = Float32Array.from({ length: 9_600 }, (_, i) => Math.sin(i / 7) * 0.8);
  const whole = encode(48_000, [signal]).frames.map(samples);
  const blocks: Float32Array[] = [];
  for (let i = 0; i < signal.length; i += 128) blocks.push(signal.slice(i, i + 128));
  assert.deepEqual(encode(48_000, blocks).frames.map(samples), whole);
  assert.equal(whole.length, 2);
});

test("a 44.1 kHz device is resampled to 16 kHz, clipped at full scale, and the last part can be flushed", () => {
  const { frames, encoder } = encode(44_100, [new Float32Array(4_410).fill(2)]);
  assert.equal(frames.length, 1, "4410 samples at 44.1 kHz are 1600 at 16 kHz");
  assert.ok(samples(frames[0]).every((value) => value === 32_767));

  encoder.push(new Float32Array(441).fill(-2));
  assert.equal(frames.length, 1, "a partial frame waits");
  encoder.flush();
  assert.equal(frames.length, 2);
  assert.equal(frames[1].byteLength, 320, "10 ms");
  assert.ok(samples(frames[1]).every((value) => value === -32_768));
});

test("a flush ends a stretch: what follows is encoded afresh, with nothing of the input before it", () => {
  const { frames, encoder } = encode(48_000, [new Float32Array(4_801).fill(0.5)]);
  encoder.flush();
  const before = frames.length;
  encoder.push(new Float32Array(4_800).fill(-0.5));
  assert.equal(frames.length, before + 1);
  assert.ok(samples(frames[before]).every((value) => value === -16_384), "no sample of the earlier input");
});
