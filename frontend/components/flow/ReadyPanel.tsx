"use client";

import { Download, FileText, Mic, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
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
import { AudioPlayer, type PlayerSource } from "@/components/flow/AudioPlayer";
import { ProblemAlert } from "@/components/flow/ProblemAlert";
import { saveRecordingAsFiles } from "@/components/save-recording";
import type { Problem } from "@/lib/flow-session";
import { formatDuration, recordingName } from "@/lib/format";
import { recordingStore, type StoredRecording } from "@/lib/recording-store";

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

/**
 * "Inspelningen är klar": the recording, named for people, with its length
 * and playback, and one primary next step. Nothing here reads as an upload.
 */
export function ReadyPanel({
  recording,
  persistent,
  problem,
  onCreate,
  onContinue,
  onDiscard,
}: {
  recording: StoredRecording;
  persistent: boolean | null;
  problem: Problem | null;
  onCreate: () => void;
  /** "Fortsätt spela in": offered when the recorder can add a part to a stopped recording. */
  onContinue?: () => void;
  onDiscard: () => void;
}) {
  const sources = usePartSources(recording);
  const [saveProblem, setSaveProblem] = useState<Problem | null>(null);
  const name = recordingName(recording.startedAt);

  async function save() {
    setSaveProblem(null);
    try {
      await saveRecordingAsFiles(recording.id);
    } catch {
      setSaveProblem({ title: "Inspelningen kunde inte sparas som fil.", detail: "Försök igen." });
    }
  }

  return (
    <div className="flex flex-col gap-6 rounded-xl border border-rule-soft bg-paper p-5 md:p-6">
      <div className="flex flex-col gap-1">
        <h2 data-phase-heading tabIndex={-1} className="text-[22px] font-semibold tracking-[-0.01em] text-ink outline-none">
          Inspelningen är klar
        </h2>
        <p className="text-[15px] text-ink-soft">
          {name} · {formatDuration(recording.durationMs)}
        </p>
      </div>

      {sources.length > 0 && <AudioPlayer key={recording.id} sources={sources} label={name} />}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="button" variant="outline" className="h-11" onClick={() => void save()}>
          <Download data-icon="inline-start" aria-hidden />
          Spara som fil
        </Button>
        <p className="min-w-0 flex-1 text-[13px] leading-snug text-ink-mute">
          {persistent
            ? "Inspelningen finns kvar på enheten tills dokumentet är skapat."
            : "Inspelningen finns bara i den här fliken. Stäng inte fliken innan dokumentet är skapat."}
        </p>
      </div>

      {saveProblem && <ProblemAlert problem={saveProblem} />}
      {problem && <ProblemAlert problem={problem} />}

      <div className="flex flex-col gap-3 sm:flex-row">
        <Button type="button" size="lg" className="h-12 rounded-xl px-6 text-[16px] sm:flex-1" onClick={onCreate}>
          <FileText data-icon="inline-start" aria-hidden />
          Skapa dokument
        </Button>
        {onContinue && (
          <Button type="button" variant="outline" className="h-12 rounded-xl px-6 text-[16px] sm:flex-1" onClick={onContinue}>
            <Mic data-icon="inline-start" aria-hidden />
            Fortsätt spela in
          </Button>
        )}
      </div>

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button type="button" variant="ghost" className="h-11 w-fit self-center text-ink-soft sm:self-start">
            <Trash2 data-icon="inline-start" aria-hidden />
            Ta bort
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ta bort inspelningen?</AlertDialogTitle>
            <AlertDialogDescription>Den går inte att få tillbaka.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11">Avbryt</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: "destructive", className: "h-11" })} onClick={onDiscard}>
              Ta bort
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
