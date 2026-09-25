"use client";

import { Pause, Play, Square } from "lucide-react";
import { useContext, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { SignedOutSlot } from "@/components/AuthGate";
import { Button } from "@/components/ui/button";
import { LevelMeter } from "@/components/flow/LevelMeter";
import { ProblemAlert } from "@/components/flow/ProblemAlert";
import { useElapsed } from "@/components/flow/recording-hooks";
import type { Problem, SessionPhase } from "@/lib/flow-session";
import { formatClock } from "@/lib/format";
import type { RecordingCapture } from "@/lib/recording-session";
import { STOP_LINE } from "@/lib/recording-view";
import { cn } from "@/lib/utils";

// Pausa and Stoppa appear under the finger that tapped Starta: a double tap's second tap must not end the meeting.
const SETTLE_MS = 700;

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
 * interrupted) and Stoppa, with warnings above them and the line saying what
 * else matters now under them. With
 * `showStatus`, the status, timer and level ride along (Strömma, where the
 * document sheet has the workspace).
 */
export function RecordingBar({
  capture,
  phase,
  stream,
  showStatus,
  warnings,
  notes,
  onPause,
  onStop,
}: {
  capture: RecordingCapture;
  phase: SessionPhase;
  stream: MediaStream | null;
  showStatus: boolean;
  /** What can lose the meeting: said as alerts, above the controls. */
  warnings: Problem[];
  notes: string[];
  onPause: () => void;
  onStop: () => void;
}) {
  const running = phase === "recording";
  const shownAt = useRef<number | null>(null);
  useEffect(() => {
    shownAt.current = Date.now();
  }, []);
  const settled = (act: () => void) => () => {
    if (shownAt.current !== null && Date.now() - shownAt.current >= SETTLE_MS) act();
  };
  return (
    <div
      className={cn(
        // Pinned to the bottom, except on a short screen (200 % zoom, a phone on its side), where it would cover the live text.
        "sticky bottom-0 -mx-4 mt-auto shrink-0 border-t border-rule-soft bg-paper px-4 pt-3 [@media(max-height:480px)]:static",
        "pb-[max(0.75rem,env(safe-area-inset-bottom))] md:-mx-8 md:px-8",
        "lg:static lg:mx-0 lg:rounded-xl lg:border lg:px-5 lg:pb-3",
      )}
    >
      {warnings.length > 0 && (
        <div className="mb-3 flex flex-col gap-2">
          {warnings.map((warning) => (
            <ProblemAlert key={warning.title} problem={warning} />
          ))}
        </div>
      )}
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
            onClick={settled(onPause)}
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
            onClick={settled(onStop)}
          >
            <Square data-icon="inline-start" aria-hidden className={cn("fill-current", showStatus && "max-sm:hidden")} />
            Stoppa
          </Button>
        </div>
      </div>
      <div className={cn("mt-2 flex flex-col gap-0.5 text-[13px] leading-snug text-ink-soft", showStatus ? "sm:text-right" : "text-center")}>
        {/* Always there, so a new note is said once; the fixed line under it is not said again with each. */}
        <div role="status" className="flex flex-col gap-0.5">
          {notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
        <p>{STOP_LINE}</p>
      </div>
    </div>
  );
}

/**
 * While the page is covered for a new login, a recording's Pausa and Stoppa stay in reach in the sign-in dialog:
 * ending a meeting needs no login, and what is recorded stays on the device either way.
 */
export function SignedOutControls({ phase, onPause, onStop }: { phase: SessionPhase; onPause: () => void; onStop: () => void }) {
  const slot = useContext(SignedOutSlot);
  if (!slot || (phase !== "recording" && phase !== "paused")) return null;
  return createPortal(
    <div role="group" aria-label="Inspelningen" className="flex flex-wrap items-center gap-2">
      <RecordingStatus phase={phase} className="mr-auto text-[15px]" />
      <Button type="button" variant="outline" className="h-11" onClick={onPause}>
        {phase === "recording" ? "Pausa" : "Fortsätt"}
      </Button>
      <Button type="button" variant="outline" className="h-11" onClick={onStop}>
        Stoppa
      </Button>
    </div>,
    slot,
  );
}
