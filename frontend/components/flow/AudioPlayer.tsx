import { Pause, Play } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
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
    <HStack role="group" aria-label={`Uppspelning: ${label}`} gap={3} align="center">
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
      />
      {/* Not isLoading, which disables the button: a press while the audio loads pauses that start. */}
      <IconButton
        label={pauses ? "Pausa uppspelningen" : "Spela upp"}
        variant="secondary"
        data-loading={state.starting || undefined}
        icon={
          state.starting ? (
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
          max={Math.max(1, Math.round(state.totalMs / 1_000))}
          step={1}
          value={Math.round(state.atMs / 1_000)}
          // Seek on every change: a local file seeks at once, and a keyboard
          // change reports its commit before its change.
          onChange={(seconds: number) => playback.seekAt(seconds * 1_000)}
          // No value bubble following the playhead; the time beside it says where it is.
          valueDisplay="none"
          formatValue={(seconds) => `${formatClock(seconds * 1_000)} av ${formatClock(state.totalMs)}`}
        />
      </StackItem>
      <Text type="supporting" hasTabularNumbers textWrap="nowrap">
        {formatClock(state.atMs)} / {formatClock(state.totalMs)}
      </Text>
      {children}
    </HStack>
  );
}
