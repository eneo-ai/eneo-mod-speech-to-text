"use client";

import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, Mic, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FlowRunPublic, FlowRunStep } from "@/lib/api";
import { formatRelativeDate } from "@/lib/format";
import { readableBaseName, type ResultFileView } from "@/lib/run-files";
import type { StepView } from "@/lib/run-progress";
import { runResultView } from "@/lib/run-result";
import { CopyButton } from "./CopyButton";
import { ResultFiles } from "./ResultFiles";
import { RunTranscript } from "./RunTranscript";
import { StepDetails } from "./StepDetails";
import { usePhaseHeading } from "./usePhaseHeading";

export const RESULT_PROSE =
  "prose max-w-none prose-headings:tracking-tight prose-h1:text-[22px] prose-h2:text-[19px] prose-h3:text-[16px] prose-p:text-[15px] prose-p:leading-relaxed prose-li:text-[15px] prose-a:underline-offset-4 prose-code:before:hidden prose-code:after:hidden";

/** A finished run: the result, its files, the transcript, and what to do next. */
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

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 pb-12 pt-2 md:px-8">
      <header className="flex flex-col gap-1">
        <h1
          ref={heading}
          tabIndex={-1}
          className="text-[26px] font-semibold leading-tight tracking-[-0.02em] outline-none md:text-[30px]"
        >
          {delivered ? "Resultatet är skickat" : "Dokumentet är klart"}
        </h1>
        {finished && <p className="text-sm text-muted-foreground">Skapad {formatRelativeDate(finished)}</p>}
      </header>

      {note && <p className="text-[15px] leading-relaxed">{note}</p>}

      {text && (
        <section aria-label="Resultat" className="flex flex-col gap-4 rounded-xl border bg-card p-4 md:p-6">
          <CopyButton text={text} label="Kopiera texten" className="self-end" />
          <article className={RESULT_PROSE}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </article>
        </section>
      )}

      {files.length > 0 && <ResultFiles flowId={flowId} runId={run.id} files={files} />}

      {showTranscript && (
        <RunTranscript
          flowId={flowId}
          runId={run.id}
          steps={stepResults}
          baseName={readableBaseName(flowName, run.created_at)}
          finishedAt={run.finished_at}
        />
      )}

      <StepDetails steps={steps} version={run.flow_version} />

      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={onNewRecording}>
          {audio ? <Mic data-icon="inline-start" aria-hidden /> : <Plus data-icon="inline-start" aria-hidden />}
          {audio ? "Ny inspelning" : "Ny körning"}
        </Button>
        <Button asChild variant="outline">
          <Link href="/flows">
            <ArrowLeft data-icon="inline-start" aria-hidden />
            Till flödena
          </Link>
        </Button>
      </div>
    </main>
  );
}
