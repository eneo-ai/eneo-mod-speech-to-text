// Strömma: hands the microphone's audio, mixed to mono, to the page in blocks
// of about 40 ms. The page resamples it to 16 kHz PCM16 for the live-text relay.
// While the recording is paused nothing is gathered. Each message from the page
// (a pause, a resume, the stop) is answered with the audio gathered up to it,
// marked `end`, so the page knows all of that stretch is there and none is lost.
// Served from /public, so the Content-Security-Policy's script-src 'self' allows it.

const BLOCK = 2048;

class LivePcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.recording = options?.processorOptions?.recording ?? true;
    this.block = new Float32Array(BLOCK);
    this.filled = 0;
    this.port.onmessage = ({ data }) => {
      this.hand(true);
      this.recording = data.recording;
    };
  }

  hand(end) {
    const samples = this.block.slice(0, this.filled);
    this.port.postMessage({ samples, end }, [samples.buffer]);
    this.filled = 0;
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
      if (this.filled === BLOCK) this.hand(false);
    }
    return true;
  }
}

registerProcessor("live-pcm", LivePcmProcessor);
