// Strömma: hands the microphone's audio, mixed to mono, to the page in blocks
// of about 40 ms. The page resamples it to 16 kHz PCM16 for the live-text relay.
// While the recording is paused nothing is gathered, and each block names the
// stretch of recording it belongs to, so audio from around a pause never
// reaches live text after it.
// Served from /public, so the Content-Security-Policy's script-src 'self' allows it.

const BLOCK = 2048;

class LivePcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { recording = true, stretch = 0 } = options?.processorOptions ?? {};
    this.recording = recording;
    this.stretch = stretch;
    this.block = new Float32Array(BLOCK);
    this.filled = 0;
    // A pause or a resume on the page: what was gathered is dropped with its stretch.
    this.port.onmessage = ({ data }) => {
      this.recording = data.recording;
      this.stretch = data.stretch;
      this.filled = 0;
    };
  }

  process(inputs) {
    const channels = inputs[0];
    if (!this.recording || !channels || channels.length === 0) return true;
    const length = channels[0].length;
    for (let i = 0; i < length; i += 1) {
      let sum = 0;
      for (let c = 0; c < channels.length; c += 1) sum += channels[c][i];
      this.block[this.filled] = sum / channels.length;
      this.filled += 1;
      if (this.filled === BLOCK) {
        this.port.postMessage({ stretch: this.stretch, samples: this.block }, [this.block.buffer]);
        this.block = new Float32Array(BLOCK);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("live-pcm", LivePcmProcessor);
