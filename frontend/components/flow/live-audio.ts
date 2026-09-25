"use client";

import type { LiveClient, LiveSession } from "@/lib/flow-session";
import { LiveTranscriber, liveSocketUrl, openLiveSocket, type LiveDeps } from "@/lib/live-transcriber";
import { loginState } from "@/lib/login-state";
import { onlineStatus } from "@/lib/online-status";
import { Pcm16Encoder } from "@/lib/pcm";

// Served from /public, which the Content-Security-Policy's script-src 'self' allows.
const WORKLET = "/live-pcm-worklet.js";

/** Strömma needs a socket and an AudioWorklet; without them the card is not offered. */
export function supportsLiveText(): boolean {
  return typeof window !== "undefined" && "WebSocket" in window && "AudioWorkletNode" in window;
}

/** What live text needs of the browser; tests give their own. */
export interface LiveEnv {
  audioContext(): AudioContext;
  workletNode(context: AudioContext, options: AudioWorkletNodeOptions): AudioWorkletNode;
  /** The transcriber's connection to the relay for one step, and its timers. */
  liveDeps(stepId: string): LiveDeps;
}

/**
 * Live text in this browser: the relay on the page's own origin, fed with the
 * recorder's own microphone through an AudioWorklet and the PCM16 encoder.
 */
export function browserLiveClient(flowId: string): LiveClient {
  return liveClient({
    audioContext: () => new AudioContext(),
    workletNode: (context, options) => new AudioWorkletNode(context, "live-pcm", options),
    liveDeps: (stepId) => ({
      openSocket: () => openLiveSocket(WebSocket, liveSocketUrl(window.location, flowId, stepId)),
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
    open(stepId, earlier): LiveSession {
      // Made first, in the start gesture, so the browser lets it run; if it
      // cannot be made, nothing else has been set up.
      let context: AudioContext | null = env.audioContext();
      let loaded: Promise<void> | null = load(context);
      let encoder: Pcm16Encoder | null = null;
      let stream: MediaStream | null = null;
      let source: MediaStreamAudioSourceNode | null = null;
      let node: AudioWorkletNode | null = null;
      // Bumped by every wiring and unwiring, so a module that loads late never wires an old try.
      let attempt = 0;
      // Bumped at every pause and resume; audio the worklet gathered in another stretch is dropped.
      let stretch = 0;
      let recording = true;

      const deps = env.liveDeps(stepId);
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
            processorOptions: { recording, stretch },
          });
          node.port.onmessage = ({ data }: MessageEvent<{ stretch: number; samples: Float32Array }>) => {
            if (data.stretch === stretch) encoder?.push(data.samples);
          };
          source.connect(node);
          await audio.resume();
        })().catch(() => {
          if (mine !== attempt) return;
          // The audio cannot feed live text: it is let go, and the connection
          // ends as a break, so the next try sets the audio up afresh.
          release();
          transcriber.fail();
        });
      };

      transcriber.start();
      return {
        getSnapshot: transcriber.getSnapshot,
        subscribe: transcriber.subscribe,
        listen(next) {
          stream = next;
          wire();
        },
        // The pause holds before encoding: the audio up to it goes out, and nothing gathered after it ever does.
        setRecording(on) {
          if (on === recording) return;
          if (!on) encoder?.flush();
          recording = on;
          stretch += 1;
          node?.port.postMessage({ recording, stretch });
          transcriber.setRecording(on);
        },
        stop() {
          encoder?.flush();
          release();
          transcriber.stop();
        },
        dispose() {
          release();
          transcriber.dispose();
        },
      };
    },
  };
}
