import { AlertTriangle, Pause, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Slider } from "@astryxdesign/core/Slider";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { formatClock } from "@/lib/format";
import { Playback, type PlaybackSnapshot, type PlayerSource } from "@/lib/playback";

/** One playback of these parts for as long as the component lives; other parts start it over. */
export function usePlayback(sources: readonly PlayerSource[]): Playback {
  const [playback] = useState(() => new Playback(sources));
  useEffect(() => playback.setSources(sources), [playback, sources]);
  return playback;
}

/**
 * Playback as it stands, for what shows it. In a tab out of view the snapshot seen last stands until the tab is shown
 * again: playing audio renders nothing there for each of its time updates, which nobody sees.
 */
export function usePlaybackState(playback: Playback): PlaybackSnapshot {
  const seen = useRef<{ playback: Playback; snapshot: PlaybackSnapshot } | null>(null);
  const subscribe = useCallback(
    (change: () => void) => {
      const stop = playback.subscribe(change);
      document.addEventListener("visibilitychange", change);
      return () => {
        stop();
        document.removeEventListener("visibilitychange", change);
      };
    },
    [playback],
  );
  const read = useCallback(() => {
    if (seen.current?.playback === playback && document.visibilityState === "hidden") return seen.current.snapshot;
    seen.current = { playback, snapshot: playback.getSnapshot() };
    return seen.current.snapshot;
  }, [playback]);
  return useSyncExternalStore(subscribe, read, read);
}

/** What a view around the player shows of playback, without the position, which changes a few times a second. */
export type PlaybackFlags = Pick<PlaybackSnapshot, "part" | "playing" | "started" | "rate" | "unavailable" | "atEnd"> & {
  atStart: boolean;
};

const flagsOf = (s: PlaybackSnapshot): PlaybackFlags => ({
  part: s.part,
  playing: s.playing,
  started: s.started,
  rate: s.rate,
  unavailable: s.unavailable,
  atEnd: s.atEnd,
  atStart: s.atMs === 0,
});

/**
 * The playback's flags, rendering again only when one changes: a transcript of an hour's meeting rendered on every
 * time update would take most of the main thread. Its playhead is drawn by useTranscriptPlayhead instead.
 */
export function usePlaybackFlags(playback: Playback): PlaybackFlags {
  const last = useRef<PlaybackFlags | null>(null);
  const read = useCallback(() => {
    const next = flagsOf(playback.getSnapshot());
    const prev = last.current;
    if (prev && (Object.keys(next) as (keyof PlaybackFlags)[]).every((k) => prev[k] === next[k])) return prev;
    return (last.current = next);
  }, [playback]);
  return useSyncExternalStore(playback.subscribe, read, read);
}

/** The widest the position's track is drawn: a step of the thumb no smaller than a pixel of it. */
const TRACK_PX = 800;
/** The thumb is drawn at most 20 times a second. */
const MIN_STEP_MS = 50;

/**
 * Where the playhead is drawn: while the audio plays, read every frame, so it glides instead of stepping with the
 * audio's time updates (on a short recording, a second is a long jump across the slider). With reduced motion,
 * and whenever it is paused, it is the snapshot's. Read every frame but rounded to a step the thumb can show (a pixel of
 * an 800 px track, 50 ms at least), so the player renders when the thumb moves and not on every frame: an hour's meeting
 * moves it a pixel every 4.5 s, and a frame's render cost a fifth of a phone's main thread.
 */
function useLivePosition(playback: Playback, state: PlaybackSnapshot): number {
  const [live, setLive] = useState<number | null>(null);
  const step = Math.max(MIN_STEP_MS, state.totalMs / TRACK_PX);
  useEffect(() => {
    if (!state.playing || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let frame = requestAnimationFrame(function draw() {
      // The same number again renders nothing.
      setLive(Math.round(playback.liveAtMs() / step) * step);
      frame = requestAnimationFrame(draw);
    });
    return () => {
      cancelAnimationFrame(frame);
      setLive(null);
    };
  }, [playback, state.playing, step]);
  return live ?? state.atMs;
}

/**
 * Plays one or more parts as one recording: play or pause, a position slider
 * (arrow keys move a second, Page Up and Page Down ten) and "0:03 / 0:06".
 * Never the browser's own controls, whose timeline runs wrong on a WebM file
 * without a length. `children` join the row, as the transcript's speed does.
 * Audio that cannot be played says so above the row, with Försök igen.
 */
export function AudioPlayer({
  playback,
  label,
  playKey,
  compact = false,
  children,
}: {
  playback: Playback;
  label: string;
  /** The key that plays and pauses where the player sits (the transcript's K): named on the button. */
  playKey?: string;
  /** A narrow row: closer controls and the position's time alone; the slider says the length to a screen reader. */
  compact?: boolean;
  children?: ReactNode;
}) {
  const state = usePlaybackState(playback);
  const atMs = useLivePosition(playback, state);
  const attach = useCallback((element: HTMLAudioElement | null) => playback.attach(element), [playback]);
  // A start that waits for the audio is paused by the same button, as toggle() does.
  const pauses = state.playing || state.starting;
  const playLabel = pauses ? "Pausa uppspelningen" : "Spela upp";

  return (
    <>
      {/* Beside the controls it is about, and announced: the press that asked for the audio is answered here. */}
      {state.unavailable && (
        <HStack role="alert" gap={2} vAlign="center" wrap="wrap">
          <Icon icon={AlertTriangle} color="error" size="sm" />
          <Text type="supporting" color="primary">
            Ljudet kunde inte spelas upp.
          </Text>
          <Button size="sm" label="Försök igen" onClick={() => playback.reload()} />
        </HStack>
      )}
    <HStack role="group" aria-label={`Uppspelning: ${label}`} gap={compact ? 2 : 3} align="center">
      <audio
        ref={attach}
        preload="metadata"
        hidden
        onPlay={playback.onPlay}
        onPause={playback.onPause}
        onLoadedMetadata={playback.onLoadedMetadata}
        onDurationChange={playback.onDurationChange}
        onTimeUpdate={playback.onTimeUpdate}
        onEnded={playback.onEnded}
        onError={playback.onError}
        onWaiting={playback.onWaiting}
        onPlaying={playback.onPlaying}
      />
      {/* Not isLoading, which disables the button: a press while the audio loads pauses that start. */}
      <IconButton
        label={playLabel}
        variant="secondary"
        aria-keyshortcuts={playKey}
        data-loading={state.starting || state.buffering || undefined}
        icon={
          // A start that waits for the audio, or audio that stopped for want of data while it plays (a slow network).
          state.starting || state.buffering ? (
            <span aria-hidden>
              <Spinner size="sm" shade="inherit" />
            </span>
          ) : (
            <Icon icon={pauses ? Pause : Play} size="sm" />
          )
        }
        onClick={() => playback.toggle()}
      />
      <StackItem size="fill">
        <Slider
          label="Position i inspelningen"
          isLabelHidden
          width="100%"
          min={0}
          // Exact, so the thumb moves with the audio; a key still moves a whole second.
          max={Math.max(1, state.totalMs / 1_000)}
          step={1}
          value={atMs / 1_000}
          // Seek on every change: a local file seeks at once, and a keyboard
          // change reports its commit before its change.
          onChange={(seconds: number) => playback.seekAt(seconds * 1_000)}
          // No value bubble following the playhead; the time beside it says where it is.
          valueDisplay="none"
          formatValue={(seconds) => `${formatClock(seconds * 1_000)} av ${formatClock(state.totalMs)}`}
        />
      </StackItem>
      <Text type="supporting" hasTabularNumbers textWrap="nowrap">
        {compact ? formatClock(state.atMs) : `${formatClock(state.atMs)} / ${formatClock(state.totalMs)}`}
      </Text>
      {children}
    </HStack>
    </>
  );
}
