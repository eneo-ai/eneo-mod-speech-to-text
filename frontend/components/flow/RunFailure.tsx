import { useContext, useState } from "react";
import { Plus, RotateCcw, Upload } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Section } from "@astryxdesign/core/Section";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { FlowRunPublic, FlowRunStep, RunContract } from "@/lib/api";
import { formatRelativeDate } from "@/lib/format";
import { transcriptFileName, type ResultFileView } from "@/lib/run-files";
import { runOutcome, type StepView } from "@/lib/run-progress";
import { outputWords, runOutput, type RunErrorView } from "@/lib/run-result";
import { CopyButton } from "./CopyButton";
import { ResultFiles } from "./ResultFiles";
import { RunTranscript } from "./RunTranscript";
import { StepList } from "./StepList";
import { StateCard } from "./StateCard";
import { usePhaseHeading } from "./usePhaseHeading";
import { LeaveContext } from "./useLeaveQuestion";

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
  run: Pick<FlowRunPublic, "id" | "status" | "created_at" | "error" | "flow_version" | "result">;
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
  /** The flow's run contract: what a run of its version without a result makes (`runOutput`). */
  contract?: RunContract | null;
}) {
  const { leaveFirst } = useContext(LeaveContext);
  const cancelled = runOutcome(run.status) === "cancelled";
  // A refusal that a new run answers leaves no point in asking Eneo again.
  const offerRetry = Boolean(onRetry) && !refusal?.startAgain;
  const offerStartAgain = Boolean(onStartAgain) && (cancelled || Boolean(refusal?.startAgain));
  const offerChooseInput = Boolean(onChooseInput) && Boolean(failure?.inputMustChange);
  const heading = usePhaseHeading(`${cancelled ? "Avbruten" : "Misslyckades"} · ${flowName}`);
  const [retrying, setRetrying] = useState(false);

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
        <VStack gap={6}>
          <VStack gap={1}>
            <Heading level={1} ref={heading} tabIndex={-1}>
              {cancelled ? "Körningen avbröts" : outputWords(runOutput(run, contract)).failed}
            </Heading>
            {run.created_at && (
              <Text as="p" type="supporting">
                Startad {formatRelativeDate(run.created_at)}
              </Text>
            )}
          </VStack>

          {/* The heading takes focus when this view appears, so the callout need not interrupt: a note, not an alert.
              A recording or file the flow cannot take is for the person to change, not an error to be red about. */}
          <Banner
            role="note"
            status={cancelled ? "info" : failure?.inputMustChange ? "warning" : "error"}
            title={failure?.step ?? (cancelled ? "Körningen stoppades" : "Körningen kunde inte slutföras")}
            description={failure?.summary ?? "Körningen kunde inte slutföras."}
            collapsible={false}
          />

          <VStack gap={3}>
            {/* One alert for each sentence, however many ways of saying it there are. */}
            {[...new Set([refusal?.message, error].filter(Boolean))].map((message) => (
              <Banner key={message} status="error" title={message} collapsible={false} />
            ))}
            {/* The page offers one of these at most, filled unless Eneo marks a retry as not safe; the way back sits beside the card. */}
            <HStack gap={3} wrap="wrap">
              {offerChooseInput && (
                <Button label="Välj nytt ljud" variant="primary" icon={<Icon icon={Upload} size="sm" color="inherit" />} onClick={() => leaveFirst(() => onChooseInput?.())} />
              )}
              {offerRetry && (
                // Secondary when Eneo marks the retry as not safe: the advice says to check what was done first.
                <Button
                  label="Försök igen"
                  variant={run.error?.retryable ? "primary" : "secondary"}
                  isLoading={retrying}
                  icon={<Icon icon={RotateCcw} size="sm" color="inherit" />}
                  onClick={() => leaveFirst(retry)}
                />
              )}
              {offerStartAgain && (
                <Button label="Starta en ny körning" variant="primary" icon={<Icon icon={Plus} size="sm" color="inherit" />} onClick={() => leaveFirst(() => onStartAgain?.())} />
              )}
            </HStack>
            {offerRetry && (
              <Text as="p" type="supporting">
                Försök igen fortsätter där körningen stannade. Det som redan blev klart görs inte om.
              </Text>
            )}
            {offerStartAgain && (
              <Text as="p" type="supporting">
                En ny körning använder samma ljud och uppgifter och gör om alla steg.
              </Text>
            )}
          </VStack>
        </VStack>
      </StateCard>

      {steps.length > 0 && (
        <VStack as="section" aria-labelledby="run-steps" gap={3}>
          <Heading level={2} id="run-steps">
            Stegen
          </Heading>
          <Section>
            <StepList steps={steps} />
          </Section>
        </VStack>
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
    <VStack gap={6}>
      <Divider />
      <VStack as="section" aria-labelledby="run-support" gap={3}>
        <Heading level={2} id="run-support">
          Kontakta support
        </Heading>
        <HStack gap={3} wrap="wrap" align="center">
          <Text type="supporting">Körnings-ID</Text>
          {/* Astryx's types leave out `lang` and `translate`, so the language of a part (WCAG 3.1.2) goes on an inline element. */}
          <span translate="no">
            <Code>{runId}</Code>
          </span>
          <CopyButton text={runId} label="Kopiera körnings-ID" />
        </HStack>
        {failure?.detail && (
          <Collapsible isOpen={open} onOpenChange={setOpen} trigger={open ? "Dölj teknisk information" : "Visa teknisk information"}>
            <VStack gap={1}>
              {/* Eneo's own words, in English. */}
              <Text as="p" type="supporting">
                <span lang="en">{failure.detail}</span>
              </Text>
              {code && (
                <Text as="p" type="code">
                  {code}
                </Text>
              )}
            </VStack>
          </Collapsible>
        )}
      </VStack>
    </VStack>
  );
}
