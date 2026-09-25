"use client";

import type { LiveClient, LiveSession } from "@/lib/flow-session";
import { LiveTranscriber, liveSocketUrl, openLiveSocket, type LiveDeps } from "@/lib/live-transcriber";
import { loginState } from "@/lib/login-state";
import { onlineStatus } from "@/lib/online-status";
import { Pcm16Encoder } from "@/lib/pcm";

// Served from /public, which the Content-Security-Policy's script-src 'self' allows.
const WORKLET = "/live-pcm-worklet.js";
// How long the stop waits for the audio thread's last audio; without it the stop names no count.
const LAST_AUDIO_WAIT_MS = 1_000;

/** Strömma needs a socket and an AudioWorklet; without them the card is not offered. */
export function supportsLiveText(): boolean {
  return typeof window !== "undefined" && "WebSocket" in window && "AudioWorkletNode" in window;
}

/** What live text needs of the browser; tests give their own. */
export interface LiveEnv {
  audioContext(): AudioContext;
  workletNode(context: AudioContext, options: AudioWorkletNodeOptions): AudioWorkletNode;
  /** The transcriber's connection to the relay for one step and recording, and its timers. */
  liveDeps(stepId: string, recordingId?: string): LiveDeps;
}

/**
 * Live text in this browser: the relay on the page's own origin, fed with the
 * recorder's own microphone through an AudioWorklet and the PCM16 encoder.
 */
export function browserLiveClient(flowId: string): LiveClient {
  return liveClient({
    audioContext: () => new AudioContext(),
    workletNode: (context, options) => new AudioWorkletNode(context, "live-pcm", options),
    liveDeps: (stepId, recordingId) => ({
      openSocket: () => openLiveSocket(WebSocket, liveSocketUrl(window.location, flowId, stepId, recordingId)),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (timer) => window.clearTimeout(timer as number),
      online: onlineStatus,
      login: loginState,
    }),
  });
}

/** Starts loading the worklet; a failure, even a synchronous one, comes back through the promise. */
function load(context: AudioContext): Promise<void> {
  const loading = Promise.resolve().then(() => context.audioWorklet.addModule(WORKLET));
  // Awaited once a stream is wired; until then nobody listens.
  loading.catch(() => undefined);
  return loading;
}

export function liveClient(env: LiveEnv): LiveClient {
  return {
    open(stepId, recordingId, earlier): LiveSession {
      // Made first, in the start gesture, so the browser lets it run; if it
      // cannot be made, nothing else has been set up.
      let context: AudioContext | null = env.audioContext();
      let loaded: Promise<void> | null = load(context);
      // The worklet has loaded into this context: audio can reach live text without a wait.
      let moduleReady = false;
      void loaded.then(() => (moduleReady = true), () => undefined);
      let encoder: Pcm16Encoder | null = null;
      let stream: MediaStream | null = null;
      let source: MediaStreamAudioSourceNode | null = null;
      let node: AudioWorkletNode | null = null;
      // Bumped by every wiring and unwiring, so a module that loads late never wires an old try.
      let attempt = 0;
      let recording = true;
      // Messages the audio thread has not answered yet; a stop waits for all of them.
      let unanswered = 0;
      let stopping = false;
      let lastAudioTimer: unknown = null;

      const deps = env.liveDeps(stepId, recordingId);
      const transcriber = new LiveTranscriber(
        {
          ...deps,
          // Each try at a connection also sets up again audio that failed before it.
          openSocket: () => {
            if (!node) wire();
            return deps.openSocket();
          },
        },
        earlier,
      );

      const unwire = () => {
        attempt += 1;
        unanswered = 0;
        if (node) node.port.onmessage = null;
        source?.disconnect();
        node?.disconnect();
        source = null;
        node = null;
      };
      // Lets all audio go; the next wiring starts from a new context.
      const release = () => {
        unwire();
        void context?.close().catch(() => undefined);
        context = null;
        loaded = null;
        moduleReady = false;
        encoder = null;
      };
      const wire = () => {
        unwire();
        if (!stream) return;
        const mine = attempt;
        const heard = stream;
        void (async () => {
          const audio = (context ??= env.audioContext());
          await (loaded ??= load(audio));
          if (mine !== attempt) return;
          encoder ??= new Pcm16Encoder(audio.sampleRate, (frame) => transcriber.pushFrame(frame));
          source = audio.createMediaStreamSource(heard);
          // No outputs: a sink that only hands the audio on.
          node = env.workletNode(audio, {
            numberOfInputs: 1,
            numberOfOutputs: 0,
            processorOptions: { recording },
          });
          node.port.onmessage = ({ data }: MessageEvent<{ samples: Float32Array; end: boolean }>) => {
            encoder?.push(data.samples);
            if (!data.end) return;
            // A pause or the stop reached the audio thread, and all it gathered before is here: the stretch ends.
            encoder?.flush();
            unanswered -= 1;
            if (unanswered === 0 && stopping) finishStop();
          };
          source.connect(node);
          await audio.resume();
        })().catch(() => {
          if (mine !== attempt) return;
          // The audio cannot feed live text: it is let go, and the connection
          // ends as a break, so the next try sets the audio up afresh.
          release();
          transcriber.fail();
          // A stop waiting for this audio's last samples gets none.
          if (stopping) finishStop();
        });
      };

      const clearLastAudioTimer = () => {
        if (lastAudioTimer !== null) deps.clearTimer(lastAudioTimer);
        lastAudioTimer = null;
      };
      const finishStop = () => {
        clearLastAudioTimer();
        encoder?.flush();
        release();
        transcriber.stop();
      };

      const ask = (message: { recording: boolean }) => {
        if (!node) return;
        unanswered += 1;
        node.port.postMessage(message);
      };

      transcriber.start();
      return {
        getSnapshot: transcriber.getSnapshot,
        subscribe: transcriber.subscribe,
        listen(next) {
          // The recorder started in this same task. Live text hears the recording from its first sample only when its
          // audio is ready now: a worklet still loading or a context not running would miss the opening, and another
          // microphone means what the last one gathered and had not yet handed on is gone.
          if (stream || !moduleReady || context?.state !== "running") transcriber.lose();
          stream = next;
          wire();
        },
        // The pause holds where the audio thread hears of it: the audio gathered up to it goes out, none after it.
        setRecording(on) {
          if (on === recording) return;
          recording = on;
          ask({ recording });
          transcriber.setRecording(on);
        },
        // The audio thread's last audio first, then the stop message.
        stop() {
          if (stopping) return;
          stopping = true;
          transcriber.end();
          if (!node) return finishStop();
          ask({ recording: false });
          lastAudioTimer = deps.setTimer(() => {
            lastAudioTimer = null;
            transcriber.lose();
            finishStop();
          }, LAST_AUDIO_WAIT_MS);
        },
        dispose() {
          clearLastAudioTimer();
          release();
          transcriber.dispose();
        },
      };
    },
  };
}
