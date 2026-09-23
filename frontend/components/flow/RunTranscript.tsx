"use client";

import { Download, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TranscriptPlayer } from "@/components/TranscriptPlayer";
import { useConfirmedWords } from "@/components/useConfirmedWords";
import { useTranscriptContext } from "@/components/useTranscriptContext";
import type { TranscriptContext } from "@/lib/transcript-context";
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

/** The run's transcript, its confirmed words and its corrections: read once, shared by the page that shows them. */
export function useRunTranscript(flowId: string, runId: string, steps: readonly FlowRunStep[], enabled = true) {
  const [transcript, , reload] = useTranscriptContext({ flowId, runId, enabled, steps });
  const [confirmedWords] = useConfirmedWords(
    transcript.stepId ? confirmedWordsStorageKey(flowId, runId, transcript.stepId) : null,
  );
  const editing = useTranscriptCorrections(flowId, runId, transcript);
  return { transcript, confirmedWords, editing, reload };
}

/**
 * The run's transcript on its own: readable, with speakers when labelled, the
 * recording to listen to, and copy and download (.txt).
 */
export function RunTranscript({
  flowId,
  runId,
  steps,
  fileName,
}: {
  flowId: string;
  runId: string;
  /** The step results, read once when the run ended. */
  steps: readonly FlowRunStep[];
  /** The .txt the download saves, see transcriptFileName. */
  fileName: string;
}) {
  const { transcript, confirmedWords, editing, reload } = useRunTranscript(flowId, runId, steps);
  return (
    <RunTranscriptView
      flowId={flowId}
      runId={runId}
      fileName={fileName}
      transcript={transcript}
      confirmedWords={confirmedWords}
      editing={editing}
      onReload={reload}
    />
  );
}

/** What RunTranscript shows once its data is read; its own component so a test can give it any state. */
export function RunTranscriptView({
  flowId,
  runId,
  fileName,
  transcript,
  confirmedWords,
  editing,
  onReload,
}: {
  flowId: string;
  runId: string;
  fileName: string;
  transcript: TranscriptContext;
  confirmedWords: ReadonlySet<string>;
  editing: ReturnType<typeof useTranscriptCorrections>;
  /** Reads the transcript and its saved corrections again. */
  onReload: () => void;
}) {
  const { corrections, saveState, localError, onCorrectionsChange, retryCorrections, downloadUnsavedCorrections } = editing;

  if (transcript.pending) {
    return (
      <div aria-hidden className="flex flex-col gap-3">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }
  if (transcript.segments.length === 0 && transcript.speakerReviews.length === 0) {
    // Nothing to show is only nothing to say when nothing went wrong reading it.
    if (!transcript.correctionProblem) return null;
    return (
      <section aria-labelledby="run-transcript" className="flex flex-col gap-3">
        <h2 id="run-transcript" className="text-lg font-semibold tracking-tight">
          Transkript
        </h2>
        <p role="alert" className="text-sm text-destructive">
          {transcript.correctionProblem}
        </p>
        <Button type="button" variant="outline" className="self-start" onClick={onReload}>
          <RotateCcw data-icon="inline-start" aria-hidden />
          Läs in igen
        </Button>
      </section>
    );
  }

  const plain = renderReviewedTranscript(transcript.segments, corrections, transcript.speakerNames);
  // Unread or unreadable saved corrections, or only the start of a longer transcript: an export now
  // would silently drop the corrections or pass the start off as the whole.
  const unread = Boolean(transcript.correctionProblem) || transcript.textPreview;

  return (
    // From a laptop's width the card keeps to the window and its text scrolls inside it, the player docked below.
    <section
      aria-labelledby="run-transcript"
      className="flex min-h-0 flex-col rounded-xl border bg-card lg:max-h-[calc(100dvh-3rem)] lg:overflow-hidden"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 pb-2 pt-3">
        <h2 id="run-transcript" className="text-[17px] font-semibold tracking-tight">
          Transkript
        </h2>
        <div className="-mr-2 flex flex-wrap gap-1">
          <CopyButton
            text={plain}
            variant="ghost"
            size="sm"
            label={<>Kopiera<span className="sr-only"> transkriptet</span></>}
            disabled={unread}
          />
          <Button type="button" variant="ghost" size="sm" disabled={unread} onClick={() => downloadText(plain, fileName)}>
            <Download data-icon="inline-start" aria-hidden />
            Ladda ner .txt<span className="sr-only">, transkriptet</span>
          </Button>
        </div>
      </div>
      {(unread || localError || saveState === "error") && (
        <div className="flex flex-col gap-2 px-4 pb-3">
          {unread && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <p className="text-sm text-muted-foreground">
                {transcript.textPreview
                  ? "Förhandsvisning, hela transkriptet kunde inte hämtas."
                  : "Transkriptet kan kopieras och laddas ner när rättningarna har lästs in."}
              </p>
              <Button type="button" variant="outline" size="sm" onClick={onReload}>
                <RotateCcw data-icon="inline-start" aria-hidden />
                Läs in igen
              </Button>
            </div>
          )}
          {localError && (
            <p role="alert" className="text-sm text-destructive">
              {localError}
            </p>
          )}
          {saveState === "error" && (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={retryCorrections}>
                Försök spara igen
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={downloadUnsavedCorrections}>
                Hämta osparade rättningar
              </Button>
            </div>
          )}
        </div>
      )}
      <TranscriptPlayer
        className="min-h-0 flex-1"
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
