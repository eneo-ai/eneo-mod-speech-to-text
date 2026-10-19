import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { formatBytes, formatPercent } from "@/lib/format";
import type { RetryWait } from "@/lib/submit-run";
import { creatingHeading } from "@/lib/flow-output";
import { StateCard } from "@/components/flow/StateCard";
import { usePhaseHeading } from "@/components/flow/usePhaseHeading";
import { RetryNotice } from "@/components/RetryNotice";
import { useSaveRecording } from "@/components/save-recording";

export type SubmissionState =
  | { kind: "idle" }
  | {
      kind: "uploading";
      filename: string;
      loaded: number;
      total: number | null;
      percent: number | null;
      /** A recording, not a chosen file: the page says which is on its way. */
      recording?: boolean;
      wait: RetryWait | null;
    }
  | {
      kind: "starting";
      wait: RetryWait | null;
      /** A recording being sent, and how many files it has (filesIn): it can be kept as files while Eneo does not answer. */
      recording?: { id: string; files: number } | null;
    };

/**
 * A document on its way, in the flow page's card: the upload, then the run's start, before the run's own view.
 * The page around it is locked (FlowRunPage): leaving would abort the upload unasked, and Avbryt, which keeps
 * the file and the details, is the way out.
 */
export function SubmittingView({
  submission,
  onCancelSubmission,
  makesText = false,
}: {
  submission: SubmissionState;
  onCancelSubmission: () => void;
  /** The flow ends in text, not a file. */
  makesText?: boolean;
}) {
  // The run's own view follows under the same heading, so nothing moves when it starts.
  const title = creatingHeading(makesText);
  const heading = usePhaseHeading(title);
  const isUploading = submission.kind === "uploading";
  return (
    <StateCard>
      <VStack gap={6}>
        <VStack gap={2}>
          <Heading level={1} ref={heading} tabIndex={-1}>
            {title}
          </Heading>
          {/* The spinner sits outside the status region: only the words are spoken. */}
          <HStack gap={2} align="center">
            <Spinner size="sm" aria-hidden />
            <Text as="p" role="status">
              {stage(submission)}
            </Text>
          </HStack>
        </VStack>
        {isUploading ? (
          <UploadProgress submission={submission} onCancel={onCancelSubmission} />
        ) : (
          submission.kind === "starting" && <Starting submission={submission} onCancel={onCancelSubmission} />
        )}
      </VStack>
    </StateCard>
  );
}

/**
 * What is under way, in words. Once every byte has left, the module hands the file on to Eneo, which can take a while
 * for a long meeting: the page says so rather than stand at "Laddar upp" with a full bar.
 */
function stage(submission: SubmissionState): string {
  if (submission.kind === "starting") return "Startar flödet…";
  if (submission.kind !== "uploading") return "Skickar…";
  const what = submission.recording ? "inspelningen" : "filen";
  return allSent(submission) ? `Eneo tar emot ${what}…` : `Laddar upp ${what}…`;
}

/** Every byte has left; Eneo is taking the file in. */
const allSent = ({ total, loaded }: Extract<SubmissionState, { kind: "uploading" }>) => total != null && total > 0 && loaded >= total;

/**
 * Eneo has the file and is asked to start the run. It may not answer for a while, so there is a way out at once: Avbryt
 * keeps the file and the details, and a recording can be saved as a file meanwhile.
 */
function Starting({ submission, onCancel }: { submission: Extract<SubmissionState, { kind: "starting" }>; onCancel: () => void }) {
  const [saveProblem, setSaveProblem] = useState(false);
  const { wait, recording } = submission;
  const saving = useSaveRecording(recording?.id ?? "", recording?.files ?? 0);
  async function save() {
    setSaveProblem(false);
    if (!(await saving.save())) setSaveProblem(true);
  }
  return (
    <VStack gap={3} hAlign="start">
      {wait && (
        <Text as="p">
          {recording ? "Inspelningen" : "Filen"} är uppladdad. {wait.retryAt === null ? "Flödet startar inte just nu." : "Vi försöker starta flödet igen."}
        </Text>
      )}
      <RetryNotice wait={wait} />
      <HStack gap={2} wrap="wrap">
        <Button label="Avbryt" variant="secondary" onClick={onCancel} />
        {recording && (
          <Button label={saving.label} variant="secondary" isLoading={saving.busy} isInterruptible onClick={() => void save()} />
        )}
      </HStack>
      {/* Eneo has the file but no run yet: a page closed now starts nothing, and Avbryt loses nothing. */}
      <Text as="p" type="supporting">
        Stäng inte sidan förrän flödet har startat. Avbryt stoppar sändningen, och{" "}
        {recording ? "inspelningen finns kvar på enheten." : "filen och uppgifterna finns kvar."}
      </Text>
      {saveProblem && <Banner status="error" title="Inspelningen kunde inte sparas som fil. Försök igen." collapsible={false} />}
    </VStack>
  );
}

// Every quarter of the upload is said once; the percentage beside the bar is not read as it counts.
const uploadMilestone = (percent: number | null) =>
  percent != null && percent >= 25 ? `${formatPercent(Math.floor(percent / 25) * 25)} uppladdat.` : "";

function UploadProgress({
  submission,
  onCancel,
}: {
  submission: Extract<SubmissionState, { kind: "uploading" }>;
  onCancel: () => void;
}) {
  const percent = Math.max(0, Math.min(100, submission.percent ?? 0));
  const sent = allSent(submission);
  return (
    <VStack gap={2}>
      <HStack justify="between" align="start" gap={4}>
        <StackItem size="fill">
          <Text maxLines={1} weight="medium">
            {submission.filename}
          </Text>
        </StackItem>
        <Button label="Avbryt uppladdningen" variant="secondary" size="sm" onClick={onCancel} />
      </HStack>
      {/* Unknown total: the bar moves without a value, and says so only as "Pågår" beside it. */}
      <ProgressBar label="Uppladdning" isLabelHidden value={percent} isIndeterminate={submission.percent == null} />
      {/* Tabular figures: the counting digits keep their width, so the words do not shift as they count. */}
      <HStack justify="between" gap={2}>
        <Text type="supporting" hasTabularNumbers>
          {formatBytes(submission.loaded)}
          {submission.total ? ` av ${formatBytes(submission.total)}` : ""}
        </Text>
        <Text type="supporting" hasTabularNumbers>
          {submission.percent != null ? formatPercent(percent) : "Pågår"}
        </Text>
      </HStack>
      {/* The next view says the document is made even if the page is closed; until Eneo has the file, it is not. */}
      <Text as="p" type="supporting">
        {sent ? "Du kan snart stänga sidan." : "Stäng inte sidan och lås inte skärmen medan det laddas upp. När det är klart kan du stänga sidan."}
      </Text>
      <VisuallyHidden as="p" role="status">
        {uploadMilestone(submission.percent)}
      </VisuallyHidden>
      <RetryNotice wait={submission.wait} />
    </VStack>
  );
}
