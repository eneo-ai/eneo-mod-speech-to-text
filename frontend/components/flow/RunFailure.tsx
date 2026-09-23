"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronDown, CircleAlert, MinusCircle, RotateCcw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import type { FlowRunPublic, FlowRunStep } from "@/lib/api";
import { formatRelativeDate } from "@/lib/format";
import { readableBaseName, type ResultFileView } from "@/lib/run-files";
import type { StepView } from "@/lib/run-progress";
import type { RunErrorView } from "@/lib/run-result";
import { CopyButton } from "./CopyButton";
import { ResultFiles } from "./ResultFiles";
import { RunTranscript } from "./RunTranscript";
import { StepList } from "./StepList";
import { PHASE_HEADING, usePhaseHeading } from "./usePhaseHeading";

/**
 * A run that did not finish: which step stopped and why, what never ran,
 * what did finish (still reachable), and the honest next steps.
 */
export function RunFailure({
  flowId,
  flowName,
  run,
  failure,
  steps,
  stepResults,
  files,
  showTranscript = false,
  error = null,
  onRetry,
}: {
  flowId: string;
  flowName: string;
  run: Pick<FlowRunPublic, "id" | "status" | "created_at" | "error">;
  failure: RunErrorView | null;
  steps: readonly StepView[];
  stepResults: readonly FlowRunStep[];
  files: readonly ResultFileView[];
  showTranscript?: boolean;
  /** Why the last "Försök igen" did not start. */
  error?: string | null;
  /** A new run with the same audio and details; absent when that cannot help. */
  onRetry?: () => Promise<void> | void;
}) {
  const cancelled = run.status.toLowerCase() === "cancelled";
  const heading = usePhaseHeading(cancelled ? "Avbruten" : "Misslyckades");
  const [retrying, setRetrying] = useState(false);
  const Icon = cancelled ? MinusCircle : CircleAlert;

  async function retry() {
    setRetrying(true);
    try {
      await onRetry?.();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 pb-12 pt-2 md:px-8">
      <header className="flex flex-col gap-1">
        <h1
          ref={heading}
          tabIndex={-1}
          className={PHASE_HEADING}
        >
          {cancelled ? "Körningen avbröts" : "Dokumentet kunde inte skapas"}
        </h1>
        {run.created_at && <p className="text-sm text-muted-foreground">Startad {formatRelativeDate(run.created_at)}</p>}
      </header>

      {/* The heading takes focus when this view appears, so the callout need not interrupt. */}
      <Alert role="note" variant={cancelled ? "default" : "destructive"}>
        <Icon aria-hidden className="size-4" />
        <AlertTitle className="leading-snug">
          {failure?.step ?? (cancelled ? "Körningen stoppades" : "Körningen kunde inte slutföras")}
        </AlertTitle>
        <AlertDescription>
          {failure?.summary ?? "Körningen kunde inte slutföras."}
        </AlertDescription>
      </Alert>

      {steps.length > 0 && (
        <section aria-labelledby="run-steps" className="flex flex-col gap-3">
          <h2 id="run-steps" className="text-lg font-semibold tracking-tight">
            Stegen
          </h2>
          <div className="rounded-xl border bg-card p-4 md:p-6">
            <StepList steps={steps} />
          </div>
        </section>
      )}

      {files.length > 0 && <ResultFiles flowId={flowId} runId={run.id} files={files} />}

      {showTranscript && (
        <RunTranscript
          flowId={flowId}
          runId={run.id}
          steps={stepResults}
          baseName={readableBaseName(flowName, run.created_at)}
        />
      )}

      <div className="flex flex-col gap-3">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          {onRetry && (
            <Button
              type="button"
              variant={run.error?.retryable ? "default" : "outline"}
              disabled={retrying}
              onClick={() => void retry()}
            >
              {retrying ? <Spinner data-icon="inline-start" aria-hidden /> : <RotateCcw data-icon="inline-start" aria-hidden />}
              Försök igen
            </Button>
          )}
          <Button asChild variant={onRetry && run.error?.retryable ? "outline" : "default"}>
            <Link href="/flows">
              <ArrowLeft data-icon="inline-start" aria-hidden />
              Till flödena
            </Link>
          </Button>
        </div>
        {onRetry && (
          <p className="text-sm text-muted-foreground">Försök igen startar en ny körning med samma ljud och uppgifter.</p>
        )}
      </div>

      <SupportDetails runId={run.id} failure={failure} code={run.error?.code} />
    </main>
  );
}

/** For support: the run id to quote, and Eneo's own technical description folded away. */
function SupportDetails({ runId, failure, code }: { runId: string; failure: RunErrorView | null; code?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-labelledby="run-support" className="flex flex-col gap-3 border-t pt-6">
      <h2 id="run-support" className="text-base font-semibold">
        Kontakta support
      </h2>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm text-muted-foreground">Körnings-ID</span>
        <code translate="no" className="rounded-md bg-muted px-2 py-1 font-mono text-sm [overflow-wrap:anywhere]">
          {runId}
        </code>
        <CopyButton text={runId} label="Kopiera körnings-ID" />
      </div>
      {failure?.detail && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="group -ml-3">
              <ChevronDown
                data-icon="inline-start"
                aria-hidden
                className="transition-transform duration-150 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
              />
              {open ? "Dölj teknisk information" : "Visa teknisk information"}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-col gap-1 pt-2 text-sm text-muted-foreground">
              <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{failure.detail}</p>
              {code && <p className="font-mono">{code}</p>}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  );
}
