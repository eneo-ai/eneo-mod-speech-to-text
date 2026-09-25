"use client";

import { Pause, Play } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { formatClock } from "@/lib/format";
import { Playback, type PlaybackSnapshot, type PlayerSource } from "@/lib/playback";

/** One playback of these parts for as long as the component lives; other parts start it over. */
export function usePlayback(sources: readonly PlayerSource[]): Playback {
  const [playback] = useState(() => new Playback(sources));
  useEffect(() => playback.setSources(sources), [playback, sources]);
  return playback;
}

export function usePlaybackState(playback: Playback): PlaybackSnapshot {
  return useSyncExternalStore(playback.subscribe, playback.getSnapshot, playback.getSnapshot);
}

/**
 * Plays one or more parts as one recording: play or pause, a position slider
 * (arrow keys move a second, Page Up and Page Down ten) and "0:03 / 0:06".
 * Never the browser's own controls, whose timeline runs wrong on a WebM file
 * without a length. `children` join the row, as the transcript's speed does.
 */
export function AudioPlayer({
  playback,
  label,
  children,
}: {
  playback: Playback;
  label: string;
  children?: ReactNode;
}) {
  const state = usePlaybackState(playback);
  const attach = useCallback((element: HTMLAudioElement | null) => playback.attach(element), [playback]);
  // A start that waits for the audio is paused by the same button, as toggle() does.
  const pauses = state.playing || state.starting;

  return (
    <div role="group" aria-label={`Uppspelning: ${label}`} className="flex items-center gap-3">
      <audio
        ref={attach}
        preload="metadata"
        className="hidden"
        onPlay={playback.onPlay}
        onPause={playback.onPause}
        onLoadedMetadata={playback.onLoadedMetadata}
        onDurationChange={playback.onDurationChange}
        onTimeUpdate={playback.onTimeUpdate}
        onEnded={playback.onEnded}
        onError={playback.onError}
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="relative shrink-0 rounded-full"
        aria-label={pauses ? "Pausa uppspelningen" : "Spela upp"}
        data-loading={state.starting || undefined}
        onClick={() => playback.toggle()}
      >
        {pauses ? (
          <Pause aria-hidden />
        ) : (
          <Play aria-hidden className="translate-x-px" />
        )}
        {state.starting && (
          // The audio loads: a ring turns around the pause sign.
          <span
            aria-hidden
            className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-current motion-reduce:animate-none"
          />
        )}
      </Button>
      <Slider
        className="h-9 min-w-0 flex-1 coarse:h-11"
        min={0}
        max={Math.max(1, Math.round(state.totalMs / 1_000))}
        step={1}
        value={[Math.round(state.atMs / 1_000)]}
        // Seek on every change: a local file seeks at once, and a keyboard
        // change reports its commit before its change.
        onValueChange={([seconds]) => playback.seekAt(seconds * 1_000)}
        thumbProps={{
          "aria-label": "Position i inspelningen",
          "aria-valuetext": `${formatClock(state.atMs)} av ${formatClock(state.totalMs)}`,
        }}
      />
      <span className="shrink-0 text-[14px] tabular-nums text-ink-soft">
        {formatClock(state.atMs)} / {formatClock(state.totalMs)}
      </span>
      {children}
    </div>
  );
}
