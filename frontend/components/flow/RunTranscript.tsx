"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TranscriptPlayer } from "@/components/TranscriptPlayer";
import { useConfirmedWords } from "@/components/useConfirmedWords";
import { useTranscriptContext } from "@/components/useTranscriptContext";
import { useTranscriptCorrections } from "@/components/useTranscriptCorrections";
import { inputFileAudioUrl, type FlowRunStep } from "@/lib/api";
import { confirmedWordsStorageKey } from "@/lib/confirmed-words";
import { renderReviewedTranscript } from "@/lib/transcript-corrections";
import { CopyButton } from "./CopyButton";

function downloadText(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * The run's transcript on the result page: readable, with speakers when
 * labelled, the recording to listen to, and copy and download (.txt).
 */
export function RunTranscript({
  flowId,
  runId,
  steps,
  baseName,
  finishedAt,
}: {
  flowId: string;
  runId: string;
  /** The step results, read once when the run ended. */
  steps: readonly FlowRunStep[];
  /** "Nämndmöte till rapport 2026-09-23"; the download adds " transkript.txt". */
  baseName: string;
  finishedAt?: string;
}) {
  const [transcript] = useTranscriptContext({ flowId, runId, enabled: true, steps });
  const [confirmedWords] = useConfirmedWords(
    transcript.stepId ? confirmedWordsStorageKey(flowId, runId, transcript.stepId) : null,
  );
  const { corrections, saveState, localError, onCorrectionsChange, retryCorrections, downloadUnsavedCorrections } =
    useTranscriptCorrections(flowId, runId, transcript);

  if (transcript.pending) {
    return (
      <div aria-hidden className="flex flex-col gap-3">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }
  if (transcript.segments.length === 0 && transcript.speakerReviews.length === 0) return null;

  const plain = renderReviewedTranscript(transcript.segments, corrections, transcript.speakerNames);
  const edited =
    saveState !== "idle" ||
    Boolean(corrections.updatedAt && finishedAt && Date.parse(corrections.updatedAt) > Date.parse(finishedAt));

  return (
    <section aria-labelledby="run-transcript" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="run-transcript" className="text-lg font-semibold tracking-tight">
          Transkript
        </h2>
        <div className="flex flex-wrap gap-2">
          <CopyButton text={plain} label="Kopiera transkriptet" />
          <Button type="button" variant="outline" onClick={() => downloadText(plain, `${baseName} transkript.txt`)}>
            <Download data-icon="inline-start" aria-hidden />
            Ladda ner<span className="sr-only"> transkriptet</span>
          </Button>
        </div>
      </div>
      {edited && (
        <p className="text-sm text-muted-foreground">
          Sammanfattningen och tidigare skapade filer uppdateras inte av rättningarna. Hämta det granskade
          transkriptet som underlag för en ny sammanfattning.
        </p>
      )}
      {localError && (
        <p role="alert" className="text-sm text-destructive">
          {localError}
        </p>
      )}
      {saveState === "error" && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={retryCorrections}>
            Försök spara igen
          </Button>
          <Button type="button" variant="ghost" onClick={downloadUnsavedCorrections}>
            Hämta osparade rättningar
          </Button>
        </div>
      )}
      <TranscriptPlayer
        className="max-h-[36rem] overflow-hidden rounded-xl border bg-card"
        segments={transcript.segments}
        speakerReviews={transcript.speakerReviews}
        correctionProblem={transcript.correctionProblem}
        fileCount={transcript.fileIds.length}
        audioSrcFor={(fileIndex) => inputFileAudioUrl(flowId, runId, transcript.fileIds[fileIndex] ?? "")}
        speakerNames={transcript.speakerNames}
        textFallback=""
        corrections={corrections}
        editable={transcript.fromMetadata}
        onCorrectionsChange={onCorrectionsChange}
        saveState={saveState}
        confirmedWords={confirmedWords}
        downloadable={false}
      />
    </section>
  );
}
