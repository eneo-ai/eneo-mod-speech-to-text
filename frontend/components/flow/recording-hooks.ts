"use client";

import { useEffect, useRef, useState } from "react";
import { useInputLevel } from "@/components/flow/LevelMeter";
import type { RecordingCapture } from "@/lib/recording-session";
import { SilenceWatch } from "@/lib/recording-view";

/** Recorded time from the recorder itself, refreshed while it records. */
export function useElapsed(capture: RecordingCapture, running: boolean): number {
  const [elapsed, setElapsed] = useState(() => capture.elapsedMs());
  useEffect(() => {
    setElapsed(capture.elapsedMs());
    if (!running) return;
    const timer = setInterval(() => setElapsed(capture.elapsedMs()), 250);
    return () => clearInterval(timer);
  }, [capture, running]);
  return elapsed;
}

/** True while a recording input has given digital silence (a muted or wrong microphone) for about 15 s. */
export function useSilence(stream: MediaStream | null, recording: boolean): boolean {
  const [silent, setSilent] = useState(false);
  const watch = useRef(new SilenceWatch());
  useInputLevel(stream, (_level, running, peak) => {
    // A suspended audio context reads as silence; say nothing then.
    if (!recording || !running) {
      watch.current.reset();
      setSilent(false);
      return;
    }
    setSilent(watch.current.update(peak, Date.now()));
  });
  useEffect(() => {
    if (!recording) setSilent(false);
  }, [recording]);
  return silent;
}

/** Sets the tab title while mounted and gives the old one back afterwards. */
export function useDocumentTitle(title: string): void {
  const previous = useRef<string | null>(null);
  useEffect(() => {
    previous.current ??= document.title;
    document.title = title;
  }, [title]);
  useEffect(
    () => () => {
      if (previous.current !== null) document.title = previous.current;
    },
    [],
  );
}
