import { useEffect, useState, useSyncExternalStore } from "react";
import type { RunContract } from "@/lib/api";
import { browserDrafts } from "@/lib/drafts";
import { FlowSession } from "@/lib/flow-session";
import { browserStorage } from "@/lib/browser-storage";
import { audioConstraints, preferredMicrophone } from "@/lib/microphone";
import { probeLength } from "@/lib/playback";
import type { CaptureDeps } from "@/lib/recording-session";
import { recordingStore, sealed } from "@/lib/recording-store";
import { browserLiveClient, supportsLiveText } from "@/components/flow/live-audio";
import { useEvictable } from "@/components/UnsentRecordings";
import { pickSupportedAudioMimetype } from "@/lib/upload";

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
};

function pickMimeType(accepted: string[] | undefined): string | null {
  if (!("MediaRecorder" in window) || !navigator.mediaDevices) return null;
  return pickSupportedAudioMimetype(accepted, (mime) => MediaRecorder.isTypeSupported(mime));
}

/** A chosen file's length from its header, or null when the browser cannot tell. */
function probeDuration(file: Blob): Promise<number | null> {
  const url = URL.createObjectURL(file);
  return probeLength(url).finally(() => URL.revokeObjectURL(url));
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
    page: document,
    window,
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
      drafts: browserDrafts(),
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
  const evictable = useEvictable();

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
    evictable,
    // The ready state offers "Fortsätt spela in" when this browser can record for the flow, no send of the
    // recording has begun (it is sealed from then on), and it did not stop because the flow takes no more.
    continueStopped:
      snapshot.modes.includes("spela-in") && !(snapshot.recording && sealed(snapshot.recording)) && !capture.limitReached
        ? () => void session.continueStopped()
        : undefined,
  };
}
