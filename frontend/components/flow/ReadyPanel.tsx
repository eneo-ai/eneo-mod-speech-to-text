"use client";

import { Download, FileText, Mic, Trash2 } from "lucide-react";
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { AudioPlayer, usePlayback } from "@/components/flow/AudioPlayer";
import { CopyButton } from "@/components/flow/CopyButton";
import { EarlierRuns } from "@/components/flow/EarlierRuns";
import { paragraphs } from "@/components/flow/LiveSheet";
import { ProblemAlert } from "@/components/flow/ProblemAlert";
import { saveRecordingAsFiles } from "@/components/save-recording";
import type { EarlierRunsSnapshot } from "@/lib/earlier-runs";
import { createActionLabel, type LiveSession, type Problem } from "@/lib/flow-session";
import { formatDuration, recordingName } from "@/lib/format";
import type { PlayerSource } from "@/lib/playback";
import { recordingStore, type StoredRecording } from "@/lib/recording-store";
import { STATE_HEADING, StateCard } from "@/components/flow/StateCard";

/** Each part of the recording as something the player can play, over its known length. */
function usePartSources(recording: StoredRecording): PlayerSource[] {
  const [sources, setSources] = useState<PlayerSource[]>([]);
  useEffect(() => {
    let cancelled = false;
    let urls: string[] = [];
    void recordingStore()
      .then((store) => store.readParts(recording.id))
      .then((files) => {
        if (cancelled) return;
        urls = files.map((file) => URL.createObjectURL(file.blob));
        setSources(
          files.map((file, i) => ({ url: urls[i], durationMs: recording.parts[file.index]?.durationMs ?? 0 })),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [recording]);
  return sources;
}

/** Strömma's live text after Stoppa, to read and copy until the document brings the final text. */
function LiveDraft({ live, makesText }: { live: LiveSession; makesText: boolean }) {
  const { pieces } = useSyncExternalStore(live.subscribe, live.getSnapshot, live.getSnapshot);
  const headingId = useId();
  const texts = paragraphs(pieces).map((group) => group.map((piece) => piece.text).join(" "));
  if (texts.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex flex-col gap-0.5">
          <h3 id={headingId} className="text-[15px] font-semibold text-ink">
            Preliminär text
          </h3>
          <p className="text-[13px] text-ink-soft">
            {makesText ? "Den slutliga texten skapas när du väljer Skapa text." : "Den slutliga texten skapas med dokumentet."}
          </p>
        </div>
        <CopyButton text={texts.join("\n\n")} label="Kopiera" />
      </div>
      {/* Scrolls on its own, by keyboard too, so a long meeting's draft keeps the actions in reach. */}
      <div
        role="region"
        aria-labelledby={headingId}
        tabIndex={0}
        className="flex max-h-60 flex-col gap-3 overflow-y-auto rounded-lg border border-rule-soft bg-paper px-4 py-3 text-[15px] leading-relaxed text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {texts.map((text, index) => (
          <p key={index}>{text}</p>
        ))}
      </div>
    </div>
  );
}

/**
 * "Inspelningen är klar": the recording, named for people, with its length
 * and playback, and one primary next step. Nothing here reads as an upload.
 */
export function ReadyPanel({
  recording,
  persistent,
  problem,
  live = null,
  finishing = false,
  makesText = false,
  onCreate,
  onContinue,
  onDiscard,
  earlierRuns,
  onOpenRun,
  onMoreRuns,
}: {
  recording: StoredRecording;
  persistent: boolean | null;
  problem: Problem | null;
  /** Strömma's live text, kept after Stoppa. */
  live?: LiveSession | null;
  /** Strömma's final text is on its way: Skapa dokument waits for it. */
  finishing?: boolean;
  /** The flow ends in text, not a file: the action and the lines say text. */
  makesText?: boolean;
  onCreate: () => void;
  /** "Fortsätt spela in": offered when the recorder can add a part to a stopped recording. */
  onContinue?: () => void;
  onDiscard: () => void;
  /** Shown once Eneo turns out to have a run for the recording already. */
  earlierRuns?: EarlierRunsSnapshot;
  onOpenRun?: (runId: string) => void;
  onMoreRuns?: () => void;
}) {
  // Eneo already has it: the run is among the earlier runs, and the copy here can go.
  const sent = problem?.sent === true;
  const sources = usePartSources(recording);
  const playback = usePlayback(sources);
  const [saveProblem, setSaveProblem] = useState<Problem | null>(null);
  const name = recordingName(recording.startedAt);
  const made = makesText ? "texten är skapad" : "dokumentet är skapat";
  // Stopped a moment after it started, most likely by mistake: going on is the likely next step.
  const moment = onContinue !== undefined && recording.durationMs < 2_000;

  async function save() {
    setSaveProblem(null);
    try {
      await saveRecordingAsFiles(recording.id);
    } catch {
      setSaveProblem({ title: "Inspelningen kunde inte sparas som fil.", detail: "Försök igen." });
    }
  }

  return (
    <StateCard>
      <div className="flex flex-col gap-1">
        <h2 data-phase-heading tabIndex={-1} className={STATE_HEADING}>
          Inspelningen är klar
        </h2>
        <p className="text-[15px] text-ink-soft">
          {name} · {formatDuration(recording.durationMs)}
        </p>
      </div>

      {sources.length > 0 && <AudioPlayer playback={playback} label={name} />}
      {live && <LiveDraft live={live} makesText={makesText} />}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="button" variant="outline" onClick={() => void save()}>
          <Download data-icon="inline-start" aria-hidden />
          Spara som fil
        </Button>
        <p className="min-w-0 flex-1 text-[13px] leading-snug text-ink-mute">
          {persistent
            ? `Inspelningen finns kvar på enheten tills ${made}.`
            : `Inspelningen finns bara i den här fliken. Stäng inte fliken innan ${made}.`}
        </p>
      </div>

      {saveProblem && <ProblemAlert problem={saveProblem} />}
      {problem && <ProblemAlert problem={problem} />}
      {sent && earlierRuns && onOpenRun && <EarlierRuns list={earlierRuns} onOpen={onOpenRun} onMore={onMoreRuns} />}

      {moment && <p className="text-[15px] text-ink">Inspelningen blev mycket kort. Välj Fortsätt spela in om den stoppades av misstag.</p>}
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button
          type="button"
          variant={moment ? "outline" : "default"}
          size="xl"
          className="sm:flex-1"
          // Not disabled, so focus stays on it; a press does nothing until the text is in.
          aria-disabled={finishing || undefined}
          onClick={onCreate}
        >
          {finishing ? (
            <Spinner data-icon="inline-start" aria-hidden />
          ) : (
            <FileText data-icon="inline-start" aria-hidden />
          )}
          {finishing ? "Slutför texten…" : createActionLabel(makesText)}
        </Button>
        {onContinue && (
          <Button type="button" variant={moment ? "default" : "outline"} size="xl" className="sm:flex-1" onClick={onContinue}>
            <Mic data-icon="inline-start" aria-hidden />
            Fortsätt spela in
          </Button>
        )}
      </div>

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            variant={sent ? "outline" : "ghost"}
            className={sent ? "w-fit" : "w-fit self-center text-ink-soft sm:self-start"}
          >
            <Trash2 data-icon="inline-start" aria-hidden />
            {sent ? "Ta bort inspelningen från enheten" : "Ta bort"}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ta bort inspelningen?</AlertDialogTitle>
            <AlertDialogDescription>Den går inte att få tillbaka.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Avbryt</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: "destructive" })} onClick={onDiscard}>
              Ta bort
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </StateCard>
  );
}
