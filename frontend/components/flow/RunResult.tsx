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
import { ResultFiles } from "./ResultFiles";
import { RunTranscript } from "./RunTranscript";
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
}) {
  const delivered = run.result?.kind === "outbound_http";
  const heading = usePhaseHeading("Klart");
  const { text, note } = runResultView(run.result);
  const finished = run.finished_at ?? run.created_at;
  // The document's file is the first one that can be fetched; any others are listed under it.
  const primary = files.find((file) => file.available) ?? null;
  const others = files.filter((file) => file !== primary);

  return (
    <main
      className={cn(
        "mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 pb-12 pt-2 md:px-8 lg:pt-8",
        showTranscript && "lg:max-w-7xl",
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
            <RunTranscript
              flowId={flowId}
              runId={run.id}
              steps={stepResults}
              fileName={transcriptFileName(flowName, run.created_at)}
              finishedAt={run.finished_at}
            />
          </div>
        )}
      </div>
    </main>
  );
}
