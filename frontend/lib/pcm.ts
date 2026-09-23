/**
 * Live text wants 16 kHz mono PCM16, little-endian, in frames of at most
 * 64 KiB; the device records at its own rate (usually 48 kHz). The encoder
 * averages the input over each output sample's span (a plain low-pass that
 * is enough for a speech preview) and hands on 100 ms frames of 3200 bytes.
 * Sample positions are counted as integers, so long meetings do not drift.
 */

const OUTPUT_RATE = 16_000;
const FRAME_SAMPLES = 1_600; // 100 ms

export class Pcm16Encoder {
  // Input not yet used, and the index of its first sample in the whole stream.
  private buffer = new Float32Array(0);
  private bufferStart = 0;
  private produced = 0;
  private frame = new DataView(new ArrayBuffer(FRAME_SAMPLES * 2));
  private filled = 0;

  constructor(
    private readonly inputRate: number,
    private readonly onFrame: (frame: ArrayBuffer) => void,
  ) {}

  push(input: Float32Array): void {
    const data = new Float32Array(this.buffer.length + input.length);
    data.set(this.buffer);
    data.set(input, this.buffer.length);
    const available = this.bufferStart + data.length;
    for (;;) {
      const start = this.inputIndex(this.produced);
      const end = Math.max(start + 1, this.inputIndex(this.produced + 1));
      if (end > available) break;
      let sum = 0;
      for (let k = start; k < end; k += 1) sum += data[k - this.bufferStart];
      this.write(sum / (end - start));
      this.produced += 1;
    }
    const keepFrom = Math.min(this.inputIndex(this.produced), available);
    this.buffer = data.slice(keepFrom - this.bufferStart);
    this.bufferStart = keepFrom;
  }

  /** Hands on a partial last frame. */
  flush(): void {
    if (this.filled === 0) return;
    this.onFrame(this.frame.buffer.slice(0, this.filled * 2));
    this.filled = 0;
  }

  private inputIndex(outputIndex: number): number {
    return Math.floor((outputIndex * this.inputRate) / OUTPUT_RATE);
  }

  private write(value: number) {
    const clamped = Math.max(-1, Math.min(1, value));
    const sample = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    this.frame.setInt16(this.filled * 2, sample, true);
    this.filled += 1;
    if (this.filled === FRAME_SAMPLES) {
      this.onFrame(this.frame.buffer.slice(0));
      this.filled = 0;
    }
  }
}
