// Strömma: hands the microphone's audio, mixed to mono, to the page in blocks
// of about 40 ms. The page resamples it to 16 kHz PCM16 for the live-text relay.
// Served from /public, so the Content-Security-Policy's script-src 'self' allows it.

const BLOCK = 2048;

class LivePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(BLOCK);
    this.filled = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const length = channels[0].length;
    for (let i = 0; i < length; i += 1) {
      let sum = 0;
      for (let c = 0; c < channels.length; c += 1) sum += channels[c][i];
      this.block[this.filled] = sum / channels.length;
      this.filled += 1;
      if (this.filled === BLOCK) {
        this.port.postMessage(this.block, [this.block.buffer]);
        this.block = new Float32Array(BLOCK);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("live-pcm", LivePcmProcessor);
