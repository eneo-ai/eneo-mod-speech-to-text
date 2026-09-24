"use client";

import { Pause, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LevelMeter } from "@/components/flow/LevelMeter";
import { useElapsed } from "@/components/flow/recording-hooks";
import type { SessionPhase } from "@/lib/flow-session";
import { formatClock } from "@/lib/format";
import type { RecordingCapture } from "@/lib/recording-session";
import { cn } from "@/lib/utils";

/** "Spelar in" with the red dot while the recorder records; "Pausad" otherwise. Never colour alone. */
export function RecordingStatus({ phase, className }: { phase: SessionPhase; className?: string }) {
  const recording = phase === "recording";
  return (
    <span className={cn("inline-flex items-center gap-2 font-medium text-ink", className)}>
      {recording ? (
        <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-record" />
      ) : (
        <Pause aria-hidden className="size-3.5 shrink-0 text-ink-soft" strokeWidth={2.5} />
      )}
      {recording ? "Spelar in" : "Pausad"}
    </span>
  );
}

/** The recorded time (paused time excluded), from the recorder itself. */
export function Timer({
  capture,
  phase,
  className,
}: {
  capture: RecordingCapture;
  phase: SessionPhase;
  className?: string;
}) {
  const elapsed = useElapsed(capture, phase === "recording");
  return <span className={cn("tabular-nums", className)}>{formatClock(elapsed)}</span>;
}

/** Spela in's workspace: the status, a large timer and a calm level. */
export function FocusedRecorder({
  capture,
  phase,
  stream,
  storageNote,
}: {
  capture: RecordingCapture;
  phase: SessionPhase;
  stream: MediaStream | null;
  /** Where the recording is kept, when that is worth saying. */
  storageNote: string | null;
}) {
  return (
    <div className="flex flex-col items-center gap-6 rounded-xl border border-rule-soft bg-paper px-6 py-10 text-center md:py-14 lg:flex-1 lg:justify-center">
      <h2 data-phase-heading tabIndex={-1} className="sr-only">
        Inspelning
      </h2>
      <RecordingStatus phase={phase} className="text-[18px]" />
      <Timer
        capture={capture}
        phase={phase}
        className="text-[64px] font-semibold leading-none tracking-[-0.04em] text-ink sm:text-[80px] md:text-[96px]"
      />
      <LevelMeter
        stream={phase === "recording" ? stream : null}
        bars={25}
        variant="wave"
        className="h-16 w-full max-w-xs justify-center"
      />
      <p className="max-w-sm text-[15px] leading-relaxed text-ink-soft">
        Texten skapas när du stoppar inspelningen.
        {storageNote && (
          <>
            <br />
            {storageNote}
          </>
        )}
      </p>
    </div>
  );
}

/**
 * The recording's controls in fixed places: Pausa (Fortsätt while paused or
 * interrupted) and Stoppa, with the line saying what matters now. With
 * `showStatus`, the status, timer and level ride along (Strömma, where the
 * document sheet has the workspace).
 */
export function RecordingBar({
  capture,
  phase,
  stream,
  showStatus,
  notices,
  onPause,
  onStop,
}: {
  capture: RecordingCapture;
  phase: SessionPhase;
  stream: MediaStream | null;
  showStatus: boolean;
  notices: string[];
  onPause: () => void;
  onStop: () => void;
}) {
  const running = phase === "recording";
  return (
    <div
      className={cn(
        // Pinned to the bottom, except on a short screen (200 % zoom, a phone on its side), where it would cover the live text.
        "sticky bottom-0 -mx-4 mt-auto shrink-0 border-t border-rule-soft bg-paper px-4 pt-3 [@media(max-height:480px)]:static",
        "pb-[max(0.75rem,env(safe-area-inset-bottom))] md:-mx-8 md:px-8",
        "lg:static lg:mx-0 lg:rounded-xl lg:border lg:px-5 lg:pb-3",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        {showStatus && (
          // On a phone: the status over the timer and level, so the buttons keep the same row.
          <div className="flex min-w-0 flex-col gap-0.5 text-[15px] sm:flex-row sm:items-center sm:gap-4">
            <RecordingStatus phase={phase} />
            <div className="flex items-center gap-3 sm:gap-4">
              <Timer capture={capture} phase={phase} className="text-[17px] font-medium text-ink" />
              <LevelMeter stream={running ? stream : null} bars={8} variant="steps" className="h-6 sm:h-7" />
            </div>
          </div>
        )}
        <div className={cn("flex", showStatus ? "ml-auto gap-2 sm:gap-3" : "w-full gap-3 lg:justify-center")}>
          <Button
            type="button"
            variant="outline"
            size="xl"
            className={cn(
              // Wide enough for "Fortsätt", so pausing moves nothing.
              showStatus ? "min-w-24 sm:min-w-[8.5rem]" : "min-w-[8.5rem] flex-1 lg:w-44 lg:flex-none",
            )}
            onClick={onPause}
          >
            {running ? (
              <Pause data-icon="inline-start" aria-hidden className={cn(showStatus && "max-sm:hidden")} />
            ) : (
              <Play data-icon="inline-start" aria-hidden className={cn(showStatus && "max-sm:hidden")} />
            )}
            {running ? "Pausa" : "Fortsätt"}
          </Button>
          <Button
            type="button"
            size="xl"
            className={cn(
              showStatus ? "sm:min-w-[8.5rem]" : "min-w-[8.5rem] flex-[1.4] lg:w-56 lg:flex-none",
            )}
            onClick={onStop}
          >
            <Square data-icon="inline-start" aria-hidden className={cn("fill-current", showStatus && "max-sm:hidden")} />
            Stoppa
          </Button>
        </div>
      </div>
      <div
        role="status"
        className={cn(
          "mt-2 flex flex-col gap-0.5 text-[13px] leading-snug text-ink-soft",
          showStatus ? "sm:text-right" : "text-center",
        )}
      >
        {notices.map((notice) => (
          <p key={notice}>{notice}</p>
        ))}
      </div>
    </div>
  );
}
