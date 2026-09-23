"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { RunContract } from "@/lib/api";
import { browserStorage, FlowSession } from "@/lib/flow-session";
import { audioConstraints, preferredMicrophone } from "@/lib/microphone";
import type { CaptureDeps } from "@/lib/recording-session";
import { recordingStore } from "@/lib/recording-store";
import { browserLiveClient, supportsLiveText } from "@/components/flow/live-audio";
import { pickSupportedAudioMimetype } from "@/lib/upload";

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
};

function pickMimeType(accepted: string[] | undefined): string | null {
  if (typeof window === "undefined" || !("MediaRecorder" in window) || !navigator.mediaDevices) return null;
  return pickSupportedAudioMimetype(accepted, (mime) => MediaRecorder.isTypeSupported(mime));
}

/** A chosen file's length from its header, or null when the browser cannot tell. */
function probeDuration(file: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (ms: number | null) => {
      clearTimeout(timer);
      audio.removeAttribute("src");
      URL.revokeObjectURL(url);
      resolve(ms);
    };
    const timer = setTimeout(() => done(null), 10_000);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1_000) : null);
    audio.onerror = () => done(null);
    audio.src = url;
  });
}

function browserCaptureDeps(): CaptureDeps {
  return {
    // The capture asks for mono speech; the chosen microphone joins its constraints.
    getStream: (constraints) =>
      navigator.mediaDevices.getUserMedia({
        ...constraints,
        audio: audioConstraints(
          preferredMicrophone(browserStorage()),
          typeof constraints.audio === "object" ? constraints.audio : {},
        ),
      }),
    // The capture's options: the format and SPEECH_RECORDING's bit rate.
    createRecorder: (stream, options) => new MediaRecorder(stream, options),
    requestWakeLock: async () =>
      (await (navigator as NavigatorWithWakeLock).wakeLock?.request("screen")) ?? null,
    page: typeof document === "undefined" ? undefined : document,
  };
}

/** The page's input session; the capture snapshot rides along for the recorder's own details. */
export function useFlowSession({
  flowId,
  flowName,
  ownerId,
  contract,
}: {
  flowId: string;
  flowName: string;
  ownerId: string;
  contract: RunContract | null;
}) {
  const [session] = useState(() => {
    const created = new FlowSession({
      flowId,
      flowName,
      ownerId,
      openStore: recordingStore,
      captureDeps: browserCaptureDeps(),
      pickMimeType,
      storage: browserStorage(),
      live: supportsLiveText() ? browserLiveClient(flowId) : null,
    });
    created.setProbeDuration(probeDuration);
    return created;
  });
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const capture = useSyncExternalStore(
    session.capture.subscribe,
    session.capture.getSnapshot,
    session.capture.getSnapshot,
  );
  // Whether this browser keeps recordings on the device; unknown until the store opens.
  const [persistent, setPersistent] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void recordingStore().then((store) => !cancelled && setPersistent(store.persistent));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => session.setFlowName(flowName), [session, flowName]);
  useEffect(() => session.setContract(contract), [session, contract]);

  // Leaving the page keeps what was recorded, paused, for recovery.
  useEffect(() => () => session.dispose(), [session]);

  return {
    session,
    snapshot,
    capture,
    persistent: capture.recording ? capture.persistent : persistent,
    // SEAM(capture.adopt): "Fortsätt spela in" on a stopped recording needs the
    // recorder to take the recording back and start a new part of it. When
    // RecordingCapture can (capture.adopt(recording) then continueRecording()),
    // return a function here; the ready state offers the action whenever it is set.
    continueStopped: undefined as (() => void) | undefined,
  };
}
