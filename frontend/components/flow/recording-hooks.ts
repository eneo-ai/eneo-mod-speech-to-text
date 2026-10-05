import { useEffect, useRef, useState } from "react";
import { useInputLevel } from "@/components/flow/LevelMeter";
import type { LiveStatus } from "@/lib/live-transcriber";
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

/**
 * Sets the tab title while mounted and gives the old one back afterwards, unless
 * the tab says something else by then: a page navigated to has set its own.
 */
export function useDocumentTitle(title: string): void {
  const previous = useRef<string | null>(null);
  const current = useRef(title);
  useEffect(() => {
    previous.current ??= document.title;
    current.current = title;
    document.title = title;
  }, [title]);
  useEffect(
    () => () => {
      if (previous.current !== null && document.title === current.current) {
        document.title = previous.current;
      }
    },
    [],
  );
}

/** How long live text must be down before the sheet says so, and up again before it takes the words back. */
export const LIVE_SETTLE_MS = 5_000;

// What cannot go on is said at once; only a break, which may mend, is waited out.
const LIVE_ENDS: ReadonlySet<LiveStatus> = new Set(["unavailable", "stopped", "ended"]);

/**
 * The live status as the sheet says it. A break is said only once it has lasted LIVE_SETTLE_MS, and once said it is
 * taken back only after the text has been up as long, so a connection that flaps is said once, not at every break.
 */
export function useSettledLiveStatus(status: LiveStatus): LiveStatus {
  const [shown, setShown] = useState(status);
  useEffect(() => {
    if (status === shown) return;
    if (LIVE_ENDS.has(status) || (status !== "reconnecting" && shown !== "reconnecting")) {
      setShown(status);
      return;
    }
    const timer = setTimeout(() => setShown(status), LIVE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [status, shown]);
  return shown;
}
