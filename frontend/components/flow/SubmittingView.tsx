import { CloudUpload } from "lucide-react";
import { useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { formatBytes, formatPercent } from "@/lib/format";
import type { RetryWait } from "@/lib/submit-run";
import { creatingHeading } from "@/lib/flow-output";
import { preloadStepList } from "@/components/flow/RunProgress";
import { StateCard, StateHead } from "@/components/flow/StateCard";
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
  // The run's view follows this one: its steps' code is fetched while the file goes up.
  useEffect(() => void preloadStepList(), []);
  return (
    <StateCard>
      <VStack gap={6}>
        <VStack gap={2}>
          <StateHead icon={CloudUpload}>
            <Heading level={1} ref={heading} tabIndex={-1}>
              {title}
            </Heading>
          </StateHead>
          {/* The spinner sits outside the status region: only the words are spoken. */}
          <HStack gap={2} align="center">
            <Spinner size="sm" aria-hidden />
            <Text as="p" role="status">
              {stage(submission)}
            </Text>
          </HStack>
          {/* What a closed page does now, read before the bar: until the run has started, a closed page stops it. The run's
              own view says what a closed page means for it. */}
          {(isUploading || submission.kind === "starting") && (
            <Text as="p" color="secondary">
              {isUploading ? "Stäng inte sidan och lås inte skärmen förrän flödet har startat." : "Stäng inte sidan förrän flödet har startat."}
            </Text>
          )}
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

/** Every byte of the upload has left: what is under way now is Eneo receiving it. */
const allSent = ({ loaded, total }: Extract<SubmissionState, { kind: "uploading" }>) => total != null && total > 0 && loaded >= total;

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
        {/* What it stops: the start. The file and the details stay. */}
        <Button label="Avbryt starten" variant="secondary" onClick={onCancel} />
        {recording && (
          <Button label={saving.label} variant="secondary" isLoading={saving.busy} isInterruptible onClick={() => void save()} />
        )}
      </HStack>
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
  return (
    <VStack gap={2}>
      {/* The file's whole name, its own line: a long one wraps rather than being cut. */}
      <Text as="p" weight="medium">
        {submission.filename}
      </Text>
      {/* Unknown total: the bar moves without a value, and says so only as "Pågår" beside it. Once every byte has left it
          moves again while Eneo receives the file: a full bar that stands still reads as done, or as stuck. */}
      <ProgressBar label="Uppladdning" isLabelHidden value={percent} isIndeterminate={submission.percent == null || allSent(submission)} />
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
      <VisuallyHidden as="p" role="status">
        {uploadMilestone(submission.percent)}
      </VisuallyHidden>
      <RetryNotice wait={submission.wait} />
      {/* The card's last row, as the run's Avbryt körningen is: what it stops, said whole. */}
      <HStack paddingBlockStart={2}>
        <Button label="Avbryt uppladdningen" variant="secondary" onClick={onCancel} />
      </HStack>
    </VStack>
  );
}
