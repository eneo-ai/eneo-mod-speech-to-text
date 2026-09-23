"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { RunContract } from "@/lib/api";
import { browserStorage, FlowSession } from "@/lib/flow-session";
import { audioConstraints, preferredMicrophone } from "@/lib/microphone";
import type { CaptureDeps } from "@/lib/recording-session";
import { recordingStore } from "@/lib/recording-store";
import { pickSupportedAudioMimetype } from "@/lib/upload";

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
};

function pickMimeType(accepted: string[] | undefined): string | null {
  if (typeof window === "undefined" || !("MediaRecorder" in window) || !navigator.mediaDevices) return null;
  return pickSupportedAudioMimetype(accepted, (mime) => MediaRecorder.isTypeSupported(mime));
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
  const [session] = useState(
    () =>
      new FlowSession({
        flowId,
        flowName,
        ownerId,
        openStore: recordingStore,
        captureDeps: browserCaptureDeps(),
        pickMimeType,
        storage: browserStorage(),
        // SEAM(strömma): true once the live client can stream this browser's audio.
        liveClient: false,
      }),
  );
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

  return { session, snapshot, capture, persistent: capture.recording ? capture.persistent : persistent };
}
