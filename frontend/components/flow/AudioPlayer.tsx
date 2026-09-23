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
        className="size-11 shrink-0 rounded-full"
        aria-label={state.playing ? "Pausa uppspelningen" : "Spela upp"}
        onClick={() => playback.toggle()}
      >
        {state.playing ? (
          <Pause aria-hidden />
        ) : (
          <Play aria-hidden className="translate-x-px" />
        )}
      </Button>
      <Slider
        className="h-11 min-w-0 flex-1"
        min={0}
        max={Math.max(1, Math.round(state.totalMs / 1_000))}
        step={1}
        value={[Math.round(state.atMs / 1_000)]}
        // Seek on every change: a local file seeks at once, and a keyboard
        // change reports its commit before its change.
        onValueChange={([seconds]) => playback.seekAt(seconds * 1_000)}
        thumbProps={{
          "aria-label": "Position",
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
