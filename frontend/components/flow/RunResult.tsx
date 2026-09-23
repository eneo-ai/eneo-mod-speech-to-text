"use client";

import Link from "next/link";
import { ArrowLeft, Mic, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FlowRunPublic, FlowRunStep } from "@/lib/api";
import { formatRelativeDate } from "@/lib/format";
import { transcriptFileName, type ResultFileView } from "@/lib/run-files";
import type { StepView } from "@/lib/run-progress";
import { runResultView } from "@/lib/run-result";
import { cn } from "@/lib/utils";
import { ResultDocument } from "./ResultDocument";
import { regenerationOffer } from "@/lib/regenerate";
import { RegenerateNotice } from "./RegenerateNotice";
import { ResultFiles } from "./ResultFiles";
import { RunTranscriptView, useRunTranscript } from "./RunTranscript";
import { StepDetails } from "./StepDetails";
import { PHASE_HEADING, usePhaseHeading } from "./usePhaseHeading";

/**
 * A finished run: what the flow produced comes first, as a readable page with
 * its file and one filled action; the transcript sits beside it from a laptop's
 * width, and starting over is a quiet action in the header.
 */
export function RunResult({
  flowId,
  flowName,
  run,
  steps,
  stepResults,
  files,
  showTranscript = true,
  audio = true,
  onNewRecording,
  onRegenerated,
}: {
  flowId: string;
  flowName: string;
  run: FlowRunPublic;
  steps: readonly StepView[];
  /** The step results, read once when the run ended. */
  stepResults: readonly FlowRunStep[];
  files: readonly ResultFileView[];
  showTranscript?: boolean;
  /** The flow takes audio, so a new run starts with a new recording. */
  audio?: boolean;
  onNewRecording: () => void;
  /** A new run was started from the reviewed transcript; the page follows it. */
  onRegenerated: (run: FlowRunPublic) => void;
}) {
  const delivered = run.result?.kind === "outbound_http";
  const heading = usePhaseHeading("Klart");
  const { text, note } = runResultView(run.result);
  const finished = run.finished_at ?? run.created_at;
  // The document's file is the first one that can be fetched; any others are listed under it.
  const primary = files.find((file) => file.available) ?? null;
  const others = files.filter((file) => file !== primary);
  const { transcript, confirmedWords, editing, reload } = useRunTranscript(flowId, run.id, stepResults, showTranscript);
  const offer =
    showTranscript && !delivered && editing.saveState !== "error"
      ? regenerationOffer({
          flowId,
          run,
          stepId: transcript.stepId,
          fromMetadata: transcript.fromMetadata,
          corrections: editing.corrections,
          hasDocument: Boolean(text || files.length),
        })
      : null;
  // A document Eneo made again from a reviewed transcript says so; it is not a sign that anyone checked it.
  const fromReviewed = Boolean((run.input_payload_json as { transcript_regeneration?: unknown } | null | undefined)?.transcript_regeneration);

  return (
    <main
      className={cn(
        "mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 pb-12 pt-2 md:px-8 lg:pt-8",
        // The frame owns the page's width; from a laptop's width the result takes what it gives.
        showTranscript && "lg:max-w-none",
      )}
    >
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 ref={heading} tabIndex={-1} className={PHASE_HEADING}>
            {delivered ? "Resultatet är skickat" : "Dokumentet är klart"}
          </h1>
          {finished && (
            <p className="text-[14px] text-muted-foreground">
              {/* On a phone the top bar already names the flow. */}
              <span className="hidden lg:inline">{flowName} · </span>
              Skapad {formatRelativeDate(finished)}
              {fromReviewed && " från det rättade transkriptet"}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" variant="outline" onClick={onNewRecording}>
            {audio ? <Mic data-icon="inline-start" aria-hidden /> : <Plus data-icon="inline-start" aria-hidden />}
            {audio ? "Ny inspelning" : "Ny körning"}
          </Button>
          <Button asChild variant="ghost" className="hidden lg:inline-flex">
            <Link href="/flows">
              <ArrowLeft data-icon="inline-start" aria-hidden />
              Till flödena
            </Link>
          </Button>
        </div>
      </header>

      <div
        className={cn(
          "flex flex-col gap-8",
          showTranscript && "lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,6fr)] lg:items-start lg:gap-x-8",
        )}
      >
        <div className="flex min-w-0 flex-col gap-6">
          {note && <p className="text-[15px] leading-relaxed">{note}</p>}
          {offer && (
            <RegenerateNotice offer={offer} saving={editing.saveState === "saving"} onStarted={onRegenerated} onReload={reload} />
          )}
          {(text || primary) && (
            <ResultDocument flowId={flowId} runId={run.id} text={text} file={primary} title={flowName} />
          )}
          {others.length > 0 && (
            <ResultFiles flowId={flowId} runId={run.id} files={others} title={primary ? "Fler filer" : "Filer"} />
          )}
          <StepDetails steps={steps} version={run.flow_version} />
        </div>

        {showTranscript && (
          <div className="min-w-0 lg:sticky lg:top-6">
            <RunTranscriptView
              flowId={flowId}
              runId={run.id}
              fileName={transcriptFileName(flowName, run.created_at)}
              transcript={transcript}
              confirmedWords={confirmedWords}
              editing={editing}
              onReload={reload}
            />
          </div>
        )}
      </div>
    </main>
  );
}
