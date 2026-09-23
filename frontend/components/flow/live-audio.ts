"use client";

import type { LiveClient, LiveSession } from "@/lib/flow-session";
import { LiveTranscriber, liveSocketUrl, openLiveSocket, type LiveDeps } from "@/lib/live-transcriber";
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
    }),
  });
}

export function liveClient(env: LiveEnv): LiveClient {
  return {
    open(stepId): LiveSession {
      const transcriber = new LiveTranscriber(env.liveDeps(stepId));
      // Made here, in the start gesture, so the browser lets it run.
      const context = env.audioContext();
      const loaded = context.audioWorklet.addModule(WORKLET);
      let encoder: Pcm16Encoder | null = null;
      let source: MediaStreamAudioSourceNode | null = null;
      let node: AudioWorkletNode | null = null;
      // Bumped by each listen, so a module that loads late never wires an old stream.
      let listening = 0;
      // Bumped at every pause and resume; audio the worklet gathered in another stretch is dropped.
      let stretch = 0;
      let recording = true;

      const unhook = () => {
        listening += 1;
        if (node) node.port.onmessage = null;
        source?.disconnect();
        node?.disconnect();
        source = null;
        node = null;
      };
      const close = () => {
        unhook();
        void context.close().catch(() => undefined);
      };

      transcriber.start();
      return {
        getSnapshot: transcriber.getSnapshot,
        subscribe: transcriber.subscribe,
        listen(stream) {
          unhook();
          const token = listening;
          void loaded
            .then(() => {
              if (token !== listening || context.state === "closed") return;
              encoder ??= new Pcm16Encoder(context.sampleRate, (frame) => transcriber.pushFrame(frame));
              source = context.createMediaStreamSource(stream);
              // No outputs: a sink that only hands the audio on.
              node = env.workletNode(context, {
                numberOfInputs: 1,
                numberOfOutputs: 0,
                processorOptions: { recording, stretch },
              });
              node.port.onmessage = ({ data }: MessageEvent<{ stretch: number; samples: Float32Array }>) => {
                if (data.stretch === stretch) encoder?.push(data.samples);
              };
              source.connect(node);
              void context.resume().catch(() => undefined);
            })
            .catch(() => undefined);
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
          close();
          transcriber.stop();
        },
        dispose() {
          close();
          transcriber.dispose();
        },
      };
    },
  };
}
