"use client";

import { Loader2 } from "lucide-react";
import type { FlowPublished } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import type { RetryWait } from "@/lib/submit-run";
import { FlowTopBar } from "@/components/flow/FlowTopBar";
import { PHASE_HEADING, usePhaseHeading } from "@/components/flow/usePhaseHeading";
import { ReadingMain } from "@/components/frame";
import { OfflineBanner } from "@/components/OfflineBanner";
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

/** A document on its way: the upload, then the run's start, before the run's own view. */
export function SubmittingView({
  published,
  submission,
  onCancelSubmission,
}: {
  published: FlowPublished;
  submission: SubmissionState;
  onCancelSubmission: () => void;
}) {
  // The run's own view follows under the same heading, so nothing moves when it starts.
  const heading = usePhaseHeading("Dokumentet skapas");
  const isUploading = submission.kind === "uploading";
  return (
    <>
      {/* Leaving would abort the upload unasked: Avbryt, which keeps the file and details, is the way out. */}
      <FlowTopBar title={published.name} titleIsHeading={false} locked />
      <ReadingMain className="gap-6">
        <OfflineBanner waiting={submission.kind === "idle" ? "run" : "upload"} />
        <div className="flex flex-col gap-2">
          <h1 ref={heading} tabIndex={-1} className={PHASE_HEADING}>
            Dokumentet skapas
          </h1>
          <p role="status" className="flex items-center gap-2 text-base">
            <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" />
            {isUploading ? "Laddar upp filen" : submission.kind === "starting" ? "Startar flödet" : "Skickar"}
          </p>
        </div>
        {isUploading ? (
          <UploadProgressCard submission={submission} onCancel={onCancelSubmission} />
        ) : (
          submission.kind === "starting" && <RetryNotice wait={submission.wait} />
        )}
      </ReadingMain>
    </>
  );
}

function UploadProgressCard({
  submission,
  onCancel,
}: {
  submission: Extract<SubmissionState, { kind: "uploading" }>;
  onCancel: () => void;
}) {
  const percent = Math.max(0, Math.min(100, submission.percent ?? 0));
  return (
    <div className="paper-card p-4 md:p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="min-w-0">
          <div className="text-[14px] md:text-[15px] font-medium text-ink truncate">
            {submission.filename}
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded-full border border-rule-soft px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-ink/40 hover:text-ink"
        >
          Avbryt
        </button>
      </div>
      <div className="h-2 rounded-full bg-bg-2 overflow-hidden mb-2">
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
      <RetryNotice wait={submission.wait} />
    </div>
  );
}
