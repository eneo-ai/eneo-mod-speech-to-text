"use client";

import { Pause, Play } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { formatClock } from "@/lib/format";

export interface PlayerSource {
  url: string;
  /** Known from the recorder; a recorded WebM file may not say its own length. */
  durationMs: number;
}

/**
 * Plays one or more parts as one recording over their known length: play or
 * pause, a position slider (arrow keys move a second, Page Up and Page Down
 * ten) and "0:03 / 0:06". Never the browser's own controls, whose timeline
 * runs wrong on a WebM file without a length.
 */
export function AudioPlayer({ sources, label }: { sources: PlayerSource[]; label: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [part, setPart] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  // Where to start in a part that is still loading, and whether to keep playing.
  const pending = useRef<{ atMs: number; play: boolean } | null>(null);

  const offsets = useMemo(
    () => sources.reduce<number[]>((all, _, i) => [...all, i === 0 ? 0 : all[i - 1] + sources[i - 1].durationMs], []),
    [sources],
  );
  const total = sources.reduce((sum, source) => sum + source.durationMs, 0);

  function seek(ms: number) {
    const at = Math.max(0, Math.min(ms, total));
    const index = Math.max(0, offsets.findLastIndex((offset) => offset <= at));
    const within = Math.min(at - offsets[index], sources[index]?.durationMs ?? 0);
    setPosition(at);
    if (index === part && audio.current) {
      audio.current.currentTime = within / 1_000;
    } else {
      pending.current = { atMs: within, play: playing };
      setPart(index);
    }
  }

  async function toggle() {
    const element = audio.current;
    if (!element) return;
    if (playing) {
      element.pause();
      return;
    }
    if (position >= total) {
      // Played to the end: start over from the first part.
      setPosition(0);
      if (part !== 0) {
        pending.current = { atMs: 0, play: true };
        setPart(0);
        return;
      }
      element.currentTime = 0;
    }
    await element.play().catch(() => undefined);
  }

  return (
    <div role="group" aria-label={`Uppspelning: ${label}`} className="flex items-center gap-3">
      <audio
        ref={audio}
        src={sources[part]?.url}
        preload="metadata"
        className="hidden"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={(event) => {
          const next = pending.current;
          if (!next) return;
          pending.current = null;
          event.currentTarget.currentTime = next.atMs / 1_000;
          if (next.play) void event.currentTarget.play().catch(() => undefined);
        }}
        onTimeUpdate={(event) => {
          const within = Math.min(event.currentTarget.currentTime * 1_000, sources[part]?.durationMs ?? 0);
          setPosition(offsets[part] + within);
        }}
        onEnded={() => {
          if (part < sources.length - 1) {
            pending.current = { atMs: 0, play: true };
            setPart(part + 1);
          } else {
            setPlaying(false);
            setPosition(total);
          }
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-11 shrink-0 rounded-full"
        aria-label={playing ? "Pausa uppspelningen" : "Spela upp"}
        onClick={() => void toggle()}
      >
        {playing ? (
          <Pause aria-hidden className="size-5" />
        ) : (
          <Play aria-hidden className="size-5 translate-x-px" />
        )}
      </Button>
      <Slider
        className="h-11 min-w-0 flex-1"
        min={0}
        max={Math.max(1, Math.round(total / 1_000))}
        step={1}
        value={[Math.round(position / 1_000)]}
        // Seek on every change: a local file seeks at once, and a keyboard
        // change reports its commit before its change.
        onValueChange={([seconds]) => seek(seconds * 1_000)}
        thumbProps={{
          "aria-label": "Position",
          "aria-valuetext": `${formatClock(position)} av ${formatClock(total)}`,
        }}
      />
      <span className="shrink-0 text-[14px] tabular-nums text-ink-soft">
        {formatClock(position)} / {formatClock(total)}
      </span>
    </div>
  );
}
