import { type RefObject, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useInputLevel } from "@/components/flow/LevelMeter";
import type { LiveStatus } from "@/lib/live-transcriber";
import type { RecordingCapture } from "@/lib/recording-session";
import { SilenceWatch } from "@/lib/recording-view";

/** Recorded time from the recorder itself in whole seconds (all the clock and the tab title show), refreshed while it records. */
export function useElapsed(capture: RecordingCapture, running: boolean): number {
  const seconds = () => Math.floor(capture.elapsedMs() / 1000) * 1000;
  const [elapsed, setElapsed] = useState(seconds);
  useEffect(() => {
    setElapsed(seconds());
    if (!running) return;
    const timer = setInterval(() => setElapsed(seconds()), 250);
    return () => clearInterval(timer);
  }, [capture, running]);
  return elapsed;
}

/** True while a recording input has given digital silence (a muted or wrong microphone) for about 15 s. */
export function useSilence(stream: MediaStream | null, recording: boolean): boolean {
  const [silent, setSilent] = useState(false);
  const watch = useRef(new SilenceWatch());
  useInputLevel(stream, (_level, running, peak) => {
    // A suspended audio context reads as silence, and a phone gives a page in the background none of the microphone
    // (the recorder tells of that gap when the page is back): say nothing then, and count from when it is in view.
    if (!recording || !running || document.visibilityState === "hidden") {
      watch.current.reset();
      setSilent(false);
      return;
    }
    setSilent(watch.current.update(peak, Date.now()));
  });
  useEffect(() => {
    if (!recording) setSilent(false);
  }, [recording]);
  // Away and back, the count starts over: a phone may freeze a page in the background, where nothing was read at all.
  useEffect(() => {
    const startOver = () => {
      watch.current.reset();
      setSilent(false);
    };
    document.addEventListener("visibilitychange", startOver);
    return () => document.removeEventListener("visibilitychange", startOver);
  }, []);
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

const onFullscreenChange = (change: () => void) => {
  document.addEventListener("fullscreenchange", change);
  return () => document.removeEventListener("fullscreenchange", change);
};

/**
 * `target` alone on the whole screen (the Fullscreen API): whether it is, and the way in and out (where the browser
 * offers it at all is the caller's to ask: `document.fullscreenEnabled`). Leaving with Esc is the browser's own.
 * Whatever the hook's owner shows ends with it: unmounted, it leaves the whole screen, so a page that moves on never
 * stands there.
 */
export function useFullscreen(target: RefObject<HTMLElement | null>) {
  const active = useSyncExternalStore(
    onFullscreenChange,
    () => document.fullscreenElement !== null && document.fullscreenElement === target.current,
    () => false,
  );
  const toggle = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void target.current?.requestFullscreen({ navigationUI: "hide" }).catch(() => undefined);
  }, [target]);
  useEffect(() => {
    const element = target.current;
    return () => {
      if (element && document.fullscreenElement === element) void document.exitFullscreen().catch(() => undefined);
    };
  }, [target]);
  return { active, toggle };
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

/** How long a live region is in the page, empty, before it is given words. */
const REGION_SETTLES_MS = 250;

/**
 * `text` for a live region that appears with the view it speaks for: empty when the region is put on the page, and the
 * words a moment later, as a change a screen reader reads out. A region that arrives with its words is not reliably read
 * (NVDA, JAWS and VoiceOver differ).
 */
export function useSaidLater(text: string): string {
  const [said, setSaid] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSaid(text), REGION_SETTLES_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return said;
}
