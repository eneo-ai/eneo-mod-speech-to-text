import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { liveClient } from "../components/flow/live-audio";
import type { LiveSocket } from "./live-transcriber";

const settle = () => new Promise((resolve) => setImmediate(resolve));

type Listener = ((event: { data: unknown }) => void) | null;

// Messages between the page and the audio thread wait here until delivered, as they do between threads.
const inFlight: Array<() => void> = [];
const deliver = () => inFlight.splice(0).forEach((send) => send());

/** One end of a MessageChannel. */
class FakePort {
  onmessage: Listener = null;
  other: FakePort | null = null;
  postMessage(data: unknown) {
    inFlight.push(() => this.other?.onmessage?.({ data }));
  }
}

interface Processor {
  port: FakePort;
  process(inputs: Float32Array[][]): boolean;
}

/** The real worklet file, run with a stand-in for the audio thread's globals. */
function loadWorklet(): new (options: unknown) => Processor {
  let Processor: (new (options: unknown) => Processor) | null = null;
  class AudioWorkletProcessor {
    port = new FakePort();
  }
  const source = readFileSync(path.join(__dirname, "../../public/live-pcm-worklet.js"), "utf8");
  runInNewContext(source, {
    AudioWorkletProcessor,
    registerProcessor: (_name: string, processor: new (options: unknown) => Processor) => (Processor = processor),
  });
  return Processor!;
}

class FakeSocket implements LiveSocket {
  binaryType = "blob";
  bufferedAmount = 0;
  sent: Array<string | ArrayBuffer> = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closedWith = code;
  }
  ready() {
    this.onmessage?.({ data: JSON.stringify({ type: "ready", sample_rate: 16_000, max_seconds: 18_000 }) });
  }
  samples() {
    return this.sent
      .filter((data): data is ArrayBuffer => data instanceof ArrayBuffer)
      .flatMap((frame) => [...new Int16Array(frame)]);
  }
}

/**
 * The adapter over a stand-in audio graph: each worklet node runs the real
 * worklet code, and `play` hands it audio as the audio thread would, 128
 * samples at a time. The context runs at 16 kHz, so a sample's value can be
 * read back from the frames the relay receives.
 */
function setupLive(options: { failLoads?: number; failResumes?: number } = {}) {
  const Processor = loadWorklet();
  const sockets: FakeSocket[] = [];
  const contexts: Array<{ state: string }> = [];
  const worklets: Processor[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  let failLoads = options.failLoads ?? 0;
  let failResumes = options.failResumes ?? 0;
  const client = liveClient({
    audioContext: () => {
      const context = {
        state: "running",
        sampleRate: 16_000,
        audioWorklet: {
          addModule: () => (failLoads-- > 0 ? Promise.reject(new Error("offline")) : Promise.resolve()),
        },
        createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
        resume: () => (failResumes-- > 0 ? Promise.reject(new Error("not allowed")) : Promise.resolve()),
        close() {
          context.state = "closed";
          return Promise.resolve();
        },
      };
      contexts.push(context);
      return context as unknown as AudioContext;
    },
    workletNode: (_context, nodeOptions) => {
      const processor = new Processor(nodeOptions);
      const port = new FakePort();
      port.other = processor.port;
      processor.port.other = port;
      worklets.push(processor);
      return { port, disconnect() {} } as unknown as AudioWorkletNode;
    },
    liveDeps: () => ({
      openSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimer: (fn, ms) => {
        const timer = { fn, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => void ((timer as { cleared: boolean }).cleared = true),
    }),
  });
  const play = (value: number, count: number) => {
    const worklet = worklets[worklets.length - 1];
    for (let i = 0; i < count; i += 128) {
      worklet.process([[new Float32Array(Math.min(128, count - i)).fill(value)]]);
    }
  };
  const elapse = (ms: number) => {
    for (const timer of [...timers]) {
      if (!timer.cleared && timer.ms <= ms) {
        timer.cleared = true;
        timer.fn();
      }
    }
  };
  return { client, sockets, contexts, worklets, play, elapse };
}

const stream = {} as MediaStream;
const pcm = (value: number) => Math.round(value * 0x7fff);

test("paused audio never reaches live text: the pause holds before encoding, and nothing gathered is left over", async () => {
  const { client, sockets, play } = setupLive();
  const session = client.open("step-audio");
  session.listen(stream);
  await settle();
  sockets[0].ready();

  play(0.25, 2_500); // a full frame and a part of the next
  deliver();
  session.setRecording(false);
  play(0.75, 3_000); // paused, before the audio thread has heard of it
  deliver();
  play(0.75, 3_000); // paused: the microphone is still open
  deliver();
  session.setRecording(true);
  deliver();
  play(0.5, 3_300);
  deliver();

  const heard = new Set(sockets[0].samples());
  assert.ok(!heard.has(pcm(0.75)), "no paused sample, whole or in part");
  assert.deepEqual([...heard].sort((a, b) => a - b), [pcm(0.25), pcm(0.5)]);
  assert.equal(
    sockets[0].samples().filter((sample) => sample === pcm(0.5)).length,
    1_600,
    "after the pause, frames start with the audio after it",
  );
});

test("a pause and a resume quicker than the audio thread hears of them let nothing from the pause through", async () => {
  const { client, sockets, play } = setupLive();
  const session = client.open("step-audio");
  session.listen(stream);
  await settle();
  sockets[0].ready();

  play(0.25, 1_600);
  deliver();
  session.setRecording(false);
  play(0.75, 4_096); // the audio thread still thinks it records
  session.setRecording(true);
  deliver();
  play(0.5, 3_300);
  deliver();

  const heard = new Set(sockets[0].samples());
  assert.ok(!heard.has(pcm(0.75)), "blocks from the paused stretch are dropped on arrival");
  assert.ok(heard.has(pcm(0.5)), "the audio after the resume goes on");
});

test("audio that cannot feed live text ends the connection as a break, and the next try sets the audio up afresh", async () => {
  for (const failure of [{ failLoads: 1 }, { failResumes: 1 }]) {
    const { client, sockets, contexts, worklets, elapse } = setupLive(failure);
    const session = client.open("step-audio");
    sockets[0].ready();
    session.listen(stream);
    await settle();
    assert.equal(session.getSnapshot().status, "reconnecting", `not "live" without audio (${Object.keys(failure)})`);
    assert.equal(contexts[0].state, "closed", "the failed audio is let go");
    assert.equal(sockets[0].closedWith, 1000);
    elapse(1_000);
    assert.equal(sockets.length, 1, "the next try waits for the close");
    sockets[0].onclose?.({ code: 1000 });

    elapse(1_000);
    await settle();
    assert.equal(contexts.length, 2, "the next try makes its audio afresh");
    assert.equal(worklets.length, failure.failLoads ? 1 : 2, "and wires it");
    sockets[1].ready();
    assert.equal(session.getSnapshot().status, "live");
    session.dispose();
  }
});
