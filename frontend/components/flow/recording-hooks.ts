"use client";

import { useEffect, useRef, useState } from "react";
import { useInputLevel } from "@/components/flow/LevelMeter";
import { guardHistory } from "@/lib/leave-guard";
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

/** True while a recording input has stayed silent for about 15 s. */
export function useSilence(stream: MediaStream | null, recording: boolean): boolean {
  const [silent, setSilent] = useState(false);
  const watch = useRef(new SilenceWatch());
  useInputLevel(stream, (level, running) => {
    // A suspended audio context reads as silence; say nothing then.
    if (!recording || !running) {
      watch.current.reset();
      setSilent(false);
      return;
    }
    setSilent(watch.current.update(level, Date.now()));
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

/** While active, browser back asks first: `onAttempt` gets the way on, to call if the user leaves. */
export function useLeaveGuard(active: boolean, onAttempt: (leave: () => void) => void): void {
  const attempt = useRef(onAttempt);
  attempt.current = onAttempt;
  useEffect(() => {
    if (!active) return;
    return guardHistory(window, (leave) => attempt.current(leave));
  }, [active]);
}
