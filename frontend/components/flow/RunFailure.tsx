"use client";

import { useState } from "react";
import { ChevronDown, CircleAlert, MinusCircle, Plus, RotateCcw, Upload } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import type { FlowRunPublic, FlowRunStep, RunContract } from "@/lib/api";
import { formatRelativeDate } from "@/lib/format";
import { transcriptFileName, type ResultFileView } from "@/lib/run-files";
import type { StepView } from "@/lib/run-progress";
import { runMadeText, type RunErrorView } from "@/lib/run-result";
import { CopyButton } from "./CopyButton";
import { ResultFiles } from "./ResultFiles";
import { RunTranscript } from "./RunTranscript";
import { StepList } from "./StepList";
import { STATE_HEADING, StateCard } from "./StateCard";
import { usePhaseHeading } from "./usePhaseHeading";

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
  refusal = null,
  onRetry,
  onStartAgain,
  onChooseInput,
  contract = null,
}: {
  flowId: string;
  flowName: string;
  run: Pick<FlowRunPublic, "id" | "status" | "created_at" | "error" | "flow_version">;
  failure: RunErrorView | null;
  steps: readonly StepView[];
  stepResults: readonly FlowRunStep[];
  files: readonly ResultFileView[];
  showTranscript?: boolean;
  /** Why the last new run did not start. */
  error?: string | null;
  /** Why Eneo would not continue the run, and whether a new run is the way on. */
  refusal?: { message: string; startAgain: boolean } | null;
  /** Eneo continues the failed run where it stopped; absent when the input itself has to change. */
  onRetry?: () => Promise<void> | void;
  /** A new run with the same audio and details: after a cancellation, or when Eneo cannot continue. */
  onStartAgain?: () => Promise<void> | void;
  /** Back to the flow's setup, for another file or recording: offered when the input itself has to change. */
  onChooseInput?: () => void;
  /** The flow's run contract: a run of its version that ends in text speaks of the text, not a document. */
  contract?: RunContract | null;
}) {
  const cancelled = run.status.toLowerCase() === "cancelled";
  // A refusal that a new run answers leaves no point in asking Eneo again.
  const offerRetry = Boolean(onRetry) && !refusal?.startAgain;
  const offerStartAgain = Boolean(onStartAgain) && (cancelled || Boolean(refusal?.startAgain));
  const offerChooseInput = Boolean(onChooseInput) && Boolean(failure?.inputMustChange);
  const heading = usePhaseHeading(`${cancelled ? "Avbruten" : "Misslyckades"} · ${flowName}`);
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
    <>
      {/* What happened and what can be done, in the card; what the run left behind follows it. */}
      <StateCard>
        <header className="flex flex-col gap-1">
          <h1
            ref={heading}
            tabIndex={-1}
            className={STATE_HEADING}
          >
            {cancelled ? "Körningen avbröts" : runMadeText(run, contract) ? "Texten kunde inte skapas" : "Dokumentet kunde inte skapas"}
          </h1>
          {run.created_at && <p className="text-sm text-muted-foreground">Startad {formatRelativeDate(run.created_at)}</p>}
        </header>

        {/* The heading takes focus when this view appears, so the callout need not interrupt. */}
        <Alert role="note" variant={cancelled ? "default" : "destructive"}>
          <Icon aria-hidden className="size-4" />
          <AlertTitle className="leading-snug">
            {failure?.step ?? (cancelled ? "Körningen stoppades" : "Körningen kunde inte slutföras")}
          </AlertTitle>
          {/* The title carries the alarm; the explanation reads in the page's own text colour. */}
          <AlertDescription className="text-ink-soft">
            {failure?.summary ?? "Körningen kunde inte slutföras."}
          </AlertDescription>
        </Alert>

        <div className="flex flex-col gap-3">
          {[refusal?.message, error].filter(Boolean).map((message) => (
            <p key={message} role="alert" className="text-sm text-destructive">
              {message}
            </p>
          ))}
          {/* The page offers one of these at most, filled unless Eneo marks a retry as not safe; the way back sits beside the card. */}
          <div className="flex flex-wrap gap-3">
            {offerChooseInput && (
              <Button type="button" onClick={onChooseInput}>
                <Upload data-icon="inline-start" aria-hidden />
                Välj en annan fil
              </Button>
            )}
            {offerRetry && (
              // Secondary when Eneo marks the retry as not safe: the advice says to check what was done first.
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
            {offerStartAgain && (
              <Button type="button" onClick={() => void onStartAgain?.()}>
                <Plus data-icon="inline-start" aria-hidden />
                Starta en ny körning
              </Button>
            )}
          </div>
          {offerRetry && (
            <p className="text-sm text-muted-foreground">
              Försök igen fortsätter där körningen stannade. Det som redan blev klart görs inte om.
            </p>
          )}
          {offerStartAgain && (
            <p className="text-sm text-muted-foreground">
              En ny körning använder samma ljud och uppgifter och gör om alla steg.
            </p>
          )}
        </div>
      </StateCard>

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
          fileName={transcriptFileName(flowName, run.created_at)}
        />
      )}

      <SupportDetails runId={run.id} failure={failure} code={run.error?.code} />
    </>
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
              {/* Eneo's own words, in English. */}
              <p lang="en" className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                {failure.detail}
              </p>
              {code && <p className="font-mono">{code}</p>}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  );
}
