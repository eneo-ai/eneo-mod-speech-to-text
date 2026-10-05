import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { formatBytes } from "@/lib/format";
import type { RetryWait } from "@/lib/submit-run";
import { creatingHeading } from "@/lib/flow-output";
import { StateCard } from "@/components/flow/StateCard";
import { usePhaseHeading } from "@/components/flow/usePhaseHeading";
import { RetryNotice } from "@/components/RetryNotice";
import { saveRecordingAsFiles } from "@/components/save-recording";

export type SubmissionState =
  | { kind: "idle" }
  | {
      kind: "uploading";
      filename: string;
      loaded: number;
      total: number | null;
      percent: number | null;
      wait: RetryWait | null;
    }
  | {
      kind: "starting";
      wait: RetryWait | null;
      /** A recording being sent: it can be kept as a file while Eneo does not answer. */
      recordingId?: string | null;
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
              {isUploading ? "Laddar upp filen" : submission.kind === "starting" ? "Startar flödet" : "Skickar"}
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
 * Eneo has the file and is asked to start the run. It may not answer for a while, so there is a way out at once: Avbryt
 * keeps the file and the details, and a recording can be saved as a file meanwhile.
 */
function Starting({ submission, onCancel }: { submission: Extract<SubmissionState, { kind: "starting" }>; onCancel: () => void }) {
  const [saveProblem, setSaveProblem] = useState(false);
  const { wait, recordingId } = submission;
  async function save() {
    setSaveProblem(false);
    try {
      await saveRecordingAsFiles(recordingId!);
    } catch {
      setSaveProblem(true);
    }
  }
  return (
    <VStack gap={3} hAlign="start">
      {wait && (
        <Text as="p">
          {recordingId ? "Inspelningen" : "Filen"} är uppladdad. {wait.retryAt === null ? "Flödet startar inte just nu." : "Vi försöker starta flödet igen."}
        </Text>
      )}
      <RetryNotice wait={wait} />
      <HStack gap={2} wrap="wrap">
        <Button label="Avbryt" variant="secondary" onClick={onCancel} />
        {recordingId && <Button label="Spara som fil" variant="secondary" onClick={() => void save()} />}
      </HStack>
      {saveProblem && <Banner status="error" title="Inspelningen kunde inte sparas som fil. Försök igen." collapsible={false} />}
    </VStack>
  );
}

// Every quarter of the upload is said once; the percentage beside the bar is not read as it counts.
const uploadMilestone = (percent: number | null) =>
  percent != null && percent >= 25 ? `${Math.floor(percent / 25) * 25} % uppladdat.` : "";

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
      <HStack justify="between" align="start" gap={4}>
        <StackItem size="fill">
          <Text maxLines={1} weight="medium">
            {submission.filename}
          </Text>
        </StackItem>
        <Button label="Avbryt" variant="secondary" size="sm" onClick={onCancel} />
      </HStack>
      {/* Unknown total: the bar moves without a value, and says so only as "Pågår" beside it. */}
      <ProgressBar label="Uppladdning" isLabelHidden value={percent} isIndeterminate={submission.percent == null} />
      <HStack justify="between" gap={2}>
        <Text type="supporting">
          {formatBytes(submission.loaded)}
          {submission.total ? ` av ${formatBytes(submission.total)}` : ""}
        </Text>
        <Text type="supporting">{submission.percent != null ? `${percent}%` : "Pågår"}</Text>
      </HStack>
      <VisuallyHidden as="p" role="status">
        {uploadMilestone(submission.percent)}
      </VisuallyHidden>
      <RetryNotice wait={submission.wait} />
    </VStack>
  );
}
