"use client";

import { Loader2 } from "lucide-react";
import { formatBytes } from "@/lib/format";
import type { RetryWait } from "@/lib/submit-run";
import { STATE_HEADING, StateCard } from "@/components/flow/StateCard";
import { usePhaseHeading } from "@/components/flow/usePhaseHeading";
import { Button } from "@/components/ui/button";
import { RetryNotice } from "@/components/RetryNotice";

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
  | { kind: "starting"; wait: RetryWait | null };

/**
 * A document on its way, in the flow page's card: the upload, then the run's start, before the run's own view.
 * The page around it is locked (FlowRunPage): leaving would abort the upload unasked, and Avbryt, which keeps
 * the file and the details, is the way out.
 */
export function SubmittingView({
  submission,
  onCancelSubmission,
}: {
  submission: SubmissionState;
  onCancelSubmission: () => void;
}) {
  // The run's own view follows under the same heading, so nothing moves when it starts.
  const heading = usePhaseHeading("Dokumentet skapas");
  const isUploading = submission.kind === "uploading";
  return (
    <StateCard>
      <div className="flex flex-col gap-2">
        <h1 ref={heading} tabIndex={-1} className={STATE_HEADING}>
          Dokumentet skapas
        </h1>
        <p role="status" className="flex items-center gap-2 text-base">
          <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" />
          {isUploading ? "Laddar upp filen" : submission.kind === "starting" ? "Startar flödet" : "Skickar"}
        </p>
      </div>
      {isUploading ? (
        <UploadProgress submission={submission} onCancel={onCancelSubmission} />
      ) : (
        submission.kind === "starting" && <RetryNotice wait={submission.wait} />
      )}
    </StateCard>
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
    <div>
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="min-w-0">
          <div className="text-[14px] md:text-[15px] font-medium text-ink truncate">
            {submission.filename}
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={onCancel}>
          Avbryt
        </Button>
      </div>
      <div
        role="progressbar"
        aria-label="Uppladdning"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={submission.percent != null ? percent : undefined}
        className="h-2 rounded-full bg-bg-2 overflow-hidden mb-2"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[12px] text-ink-mute">
        <span>
          {formatBytes(submission.loaded)}
          {submission.total ? ` av ${formatBytes(submission.total)}` : ""}
        </span>
        <span>{submission.percent != null ? `${percent}%` : "Pågår"}</span>
      </div>
      <p role="status" className="sr-only">
        {uploadMilestone(submission.percent)}
      </p>
      <RetryNotice wait={submission.wait} />
    </div>
  );
}
