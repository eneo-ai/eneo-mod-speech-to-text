"use client";

import { useTranscriptCorrections } from "@/components/useTranscriptCorrections";

import Link from "next/link";
import {
  CheckCircle2,
  ChevronLeft,
  Circle,
  Download,
  Loader2,
  Send,
  Share2,
  XCircle,
} from "lucide-react";
import { SPEAKER_REVIEW_ENABLED } from "@/lib/speaker-review";
import { use, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AuthGate, useAuthenticatedUser } from "@/components/AuthGate";
import { AccountMenu } from "@/components/AccountMenu";
import { createDocument } from "@/components/flow/DetailsForm";
import { FlowInput } from "@/components/flow/FlowInput";
import { FlowSkeleton, FlowUnavailable } from "@/components/flow/FlowPageStates";
import { useFlowSession } from "@/components/flow/useFlowSession";
import { OfflineBanner } from "@/components/OfflineBanner";
import { RetryNotice } from "@/components/RetryNotice";
import { useUnsentRecordings } from "@/components/UnsentRecordings";
import {
  approveReviewCheckpoint,
  editReviewCheckpoint,
  getActiveReviewCheckpoint,
  getArtifactSignedUrl,
  getFlowGraph,
  getFlowOutputType,
  getPublishedFlow,
  getRun,
  getRunContract,
  getRunStatus,
  getRunSteps,
  inputFileAudioUrl,
  isResumableRunStatus,
  isReviewCheckpointApproved,
  isTextualOutput,
  listRuns,
  rejectReviewCheckpoint,
  resumeReviewCheckpoint,
  reviewResumeIdempotencyKey,
  type FlowGraph,
  type FlowPublished,
  type FlowRunPublic,
  type FlowRunReviewCheckpointPublic,
  type FlowRunStep,
  type FlowRunSummary,
  type Json,
  type ReviewEditedValue,
  type RunContract,
} from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import type { SubmitRequest } from "@/lib/flow-session";
import { onlineStatus } from "@/lib/online-status";
import { recordingStore } from "@/lib/recording-store";
import {
  submitRecording,
  submitRun,
  withRetry,
  type RetryWait,
  type SubmitProgress,
} from "@/lib/submit-run";
import { runErrorView, runResultView } from "@/lib/run-result";
import {
  buildEditedMapping,
  buildSpeakerRows,
  getSpeakerMappingInferNames,
  getSpeakerMappingParticipants,
  getSpeakerMappingSourceStep,
  isSpeakerMappingCheckpoint,
  proposalNameToLabel,
  speakerNamesFromRows,
  unmappedSpeakerLabels,
  type SpeakerMappingRow,
} from "@/lib/speaker-mapping";
import { firstSegmentForSpeaker, speakerDisplayLabel } from "@/lib/transcript";
import { SpeakerMappingEditor } from "@/components/SpeakerMappingEditor";
import {
  TranscriptPlayer,
  type TranscriptPlayerHandle,
} from "@/components/TranscriptPlayer";
import { useTranscriptContext } from "@/components/useTranscriptContext";
import { useConfirmedWords } from "@/components/useConfirmedWords";
import { confirmedWordsStorageKey } from "@/lib/confirmed-words";
import { formatBytes } from "@/lib/format";
import { selectRuntimeInputStep } from "@/lib/upload";

interface PageProps {
  // App Router levererar params som en Promise och packar upp dem med React.use().
  params: Promise<{ id: string }>;
}

export default function FlowDetailPage({ params }: PageProps) {
  const { id } = use(params);
  return (
    <AuthGate>
      <FlowDetail flowId={id} />
    </AuthGate>
  );
}

type RunState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "running"; run: FlowRunPublic; steps: FlowRunStep[] }
  | {
      kind: "awaiting_review";
      run: FlowRunPublic;
      steps: FlowRunStep[];
      checkpoint: FlowRunReviewCheckpointPublic;
    }
  | { kind: "done"; run: FlowRunPublic; steps: FlowRunStep[] };

type SubmissionState =
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

/** Körningens indata: en vald fil eller en inspelning som finns på enheten. */
interface ResultFileRef {
  file_id: string;
  name?: string;
  mimetype?: string | null;
  size?: number;
}

// Körningens id ligger i URL:en (?run=…) så att en omladdning, eller en
// delad länk, kan återuppta samma körning i stället för att tappa den.
const RUN_QUERY_PARAM = "run";
// "Skicka" på en osänd inspelning i flödeslistan öppnar flödet med ?recording=…
const RECORDING_QUERY_PARAM = "recording";

function readRunIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(RUN_QUERY_PARAM);
}

function writeRunIdToUrl(runId: string | null) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (runId) url.searchParams.set(RUN_QUERY_PARAM, runId);
  else url.searchParams.delete(RUN_QUERY_PARAM);
  window.history.replaceState(window.history.state, "", url);
}

function FlowDetail({ flowId }: { flowId: string }) {
  const [published, setPublished] = useState<FlowPublished | null>(null);
  const [contract, setContract] = useState<RunContract | null>(null);
  const [graph, setGraph] = useState<FlowGraph | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const [run, setRun] = useState<RunState>({ kind: "idle" });
  const [submission, setSubmission] = useState<SubmissionState>({
    kind: "idle",
  });
  const [signedUrls, setSignedUrls] = useState<
    Record<string, { url: string }>
  >({});
  const [resumableRuns, setResumableRuns] = useState<FlowRunSummary[]>([]);

  const pollAbortRef = useRef<{ aborted: boolean }>({ aborted: false });
  const submitAbortRef = useRef<AbortController | null>(null);

  const user = useAuthenticatedUser();
  // The input side (mode, details, recording, file) has one owner: the session.
  const input = useFlowSession({
    flowId,
    flowName: published?.name ?? "",
    ownerId: user.id,
    contract,
  });
  const { session, snapshot } = input;
  const currentRecordingId = snapshot.recording?.id ?? null;
  const unsentRecordings = useUnsentRecordings(user.id, flowId).filter(
    (recording) => recording.id !== currentRecordingId,
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getPublishedFlow(flowId),
      getRunContract(flowId),
      getFlowGraph(flowId).catch(() => null),
    ])
      .then(([p, c, g]) => {
        if (cancelled) return;
        setPublished(p);
        setContract(c);
        setGraph(g);

        // Återuppta körningen i URL:en (t.ex. efter omladdning mitt i en
        // granskning). Annars: leta upp pågående körningar att erbjuda.
        const urlRunId = readRunIdFromUrl();
        if (urlRunId) {
          resumeRun(urlRunId);
        } else {
          listRuns(flowId, 10)
            .then((res) => {
              if (cancelled) return;
              setResumableRuns(
                (res.items ?? []).filter((r) => isResumableRunStatus(r.status)),
              );
            })
            .catch(() => undefined);
        }
      })
      .catch((err) => !cancelled && setLoadError(err));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId]);

  useEffect(() => {
    return () => {
      pollAbortRef.current.aborted = true;
      submitAbortRef.current?.abort();
    };
  }, []);

  // Leaving asks first while audio is being recorded or waits to become a document.
  const holdsAudio = snapshot.phase !== "setup";
  useEffect(() => {
    const shouldWarn = holdsAudio || submission.kind !== "idle";
    if (!shouldWarn) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [holdsAudio, submission.kind]);

  // Etiketter per step_id hämtas från grafen — nya specen tappar step_label på FlowRunStep.
  const stepLabels = useMemo<Record<string, string>>(() => {
    if (!graph) return {};
    const m: Record<string, string> = {};
    for (const n of graph.nodes) {
      if (n.label) m[n.id] = n.label;
    }
    return m;
  }, [graph]);

  // Öppnad från "Skicka" i flödeslistan: skicka inspelningen när flödet har laddats.
  useEffect(() => {
    if (!contract) return;
    const url = new URL(window.location.href);
    const recordingId = url.searchParams.get(RECORDING_QUERY_PARAM);
    if (!recordingId) return;
    url.searchParams.delete(RECORDING_QUERY_PARAM);
    window.history.replaceState(window.history.state, "", url);
    recordingStore()
      .then((store) => store.get(recordingId))
      .then((recording) => {
        if (recording?.ownerId === user.id && recording.flowId === flowId) {
          session.adopt(recording);
          void createDocument(session);
        }
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract]);

  // The session hands the document to the run code below.
  useEffect(() => session.setHandlers({ submit: sendInput, reloadFlow }));

  /** A newer published version: the flow and its contract, loaded again in place. */
  async function reloadFlow() {
    const [p, c] = await Promise.all([getPublishedFlow(flowId), getRunContract(flowId)]);
    setPublished(p);
    setContract(c);
  }

  /** Uploads the input and starts the run; throws, with the page back in its input state, when it could not. */
  async function sendInput({ input: runInput, payload, speakerLabels }: SubmitRequest) {
    if (!contract) throw new Error("Flödet har inte laddats klart.");
    setRunError(null);
    setSignedUrls({});
    setRun({ kind: "submitting" });
    setSubmission({ kind: "idle" });
    const abortController = new AbortController();
    submitAbortRef.current = abortController;

    try {
      const params = {
        flowId,
        contract,
        stepId: selectRuntimeInputStep(contract)?.step_id ?? null,
        inputPayload: payload,
        speakerLabels,
        online: onlineStatus,
        signal: abortController.signal,
        onProgress: (progress: SubmitProgress) =>
          setSubmission({ kind: "uploading", ...progress, wait: null }),
        onStarting: () => setSubmission({ kind: "starting", wait: null }),
        onWait: (wait: RetryWait | null) =>
          setSubmission((prev) => (prev.kind === "idle" ? prev : { ...prev, wait })),
      };
      const initialRun =
        runInput?.kind === "recording"
          ? await submitRecording(await recordingStore(), runInput.recording.id, params)
          : await submitRun({
              ...params,
              files: runInput ? [{ blob: runInput.blob, filename: runInput.filename }] : [],
            });
      submitAbortRef.current = null;
      setSubmission({ kind: "idle" });

      writeRunIdToUrl(initialRun.id);
      pollAbortRef.current = { aborted: false };
      setRun({ kind: "running", run: initialRun, steps: [] });
      pollUntilDone(initialRun.id, pollAbortRef.current);
    } catch (err) {
      setRun({ kind: "idle" });
      setSubmission({ kind: "idle" });
      submitAbortRef.current = null;
      throw err;
    }
  }

  /** Plockar upp en befintlig körning (från URL eller listan) och följer den. */
  function resumeRun(runId: string) {
    pollAbortRef.current.aborted = true;
    pollAbortRef.current = { aborted: false };
    setRunError(null);
    setSignedUrls({});
    setResumableRuns([]);
    writeRunIdToUrl(runId);
    setRun({
      kind: "running",
      run: { id: runId, flow_id: flowId, status: "running" },
      steps: [],
    });
    pollUntilDone(runId, pollAbortRef.current);
  }

  async function pollUntilDone(
    runId: string,
    abort: { aborted: boolean },
  ) {
    const intervalMs = 1500;
    while (!abort.aborted) {
      try {
        // Status-endpointen är gjord för polling; detaljen (med resultat)
        // audit-loggas per läsning och hämtas därför först när körningen är klar.
        // Körningen fortsätter i Eneo när anslutningen bryts; följ den igen när den är tillbaka.
        const [summary, steps] = await withRetry(
          () =>
            Promise.all([
              getRunStatus(flowId, runId),
              getRunSteps(flowId, runId).catch(() => [] as FlowRunStep[]),
            ]),
          { online: onlineStatus },
        );
        if (abort.aborted) return;
        const r: FlowRunPublic = summary;
        if (isTerminal(r.status)) {
          const detail = await getRun(flowId, runId).catch(() => r);
          if (abort.aborted) return;
          setRun({ kind: "done", run: detail, steps });
          if (isSuccess(detail.status)) {
            await fetchSignedUrls(runId, detail.result_files ?? []);
          }
          return;
        }
        if (r.status === "awaiting_review") {
          // Hämta active checkpoint; om vi inte hittar någon (race) fortsätter vi polla.
          const cp = await getActiveReviewCheckpoint(flowId, runId).catch(
            () => null,
          );
          if (abort.aborted) return;
          if (cp) {
            setRun({ kind: "awaiting_review", run: r, steps, checkpoint: cp });
            // Vänta tills användaren agerat — review-UI:t avbryter pollingen
            // via pollAbortRef när knapp trycks. Här stannar vi helt.
            return;
          }
        }
        setRun({ kind: "running", run: r, steps });
      } catch (err) {
        if (abort.aborted) return;
        setRunError(friendlyError(err));
        setRun({ kind: "idle" });
        return;
      }
      await new Promise((res) => setTimeout(res, intervalMs));
    }
  }

  async function onApproveAndResume(
    checkpoint: FlowRunReviewCheckpointPublic,
    runState: { run: FlowRunPublic; steps: FlowRunStep[] },
  ) {
    setRunError(null);
    try {
      const approved = await approveCheckpointWithRecovery(
        checkpoint,
        runState.run.id,
      );
      const resumedRun = await resumeCheckpointWithRecovery(
        approved,
        runState.run,
      );
      // Återstarta polling — runen är nu i "running" igen.
      pollAbortRef.current = { aborted: false };
      setRun({ kind: "running", run: resumedRun, steps: runState.steps });
      pollUntilDone(resumedRun.id, pollAbortRef.current);
    } catch (err) {
      setRunError(friendlyError(err));
    }
  }

  async function approveCheckpointWithRecovery(
    checkpoint: FlowRunReviewCheckpointPublic,
    runId: string,
  ): Promise<FlowRunReviewCheckpointPublic> {
    try {
      return await approveReviewCheckpoint(flowId, runId, checkpoint.id, {
        expected_checkpoint_revision: checkpoint.revision,
      });
    } catch (err) {
      const latest = await getActiveReviewCheckpoint(flowId, runId).catch(
        () => null,
      );
      if (latest?.id === checkpoint.id && isReviewCheckpointApproved(latest)) {
        return latest;
      }
      throw err;
    }
  }

  async function resumeCheckpointWithRecovery(
    checkpoint: FlowRunReviewCheckpointPublic,
    run: FlowRunPublic,
  ): Promise<FlowRunPublic> {
    const idempotencyKey = reviewResumeIdempotencyKey(run.id, checkpoint.id);
    try {
      const resumed = await resumeReviewCheckpoint(
        flowId,
        run.id,
        checkpoint.id,
        { expected_checkpoint_revision: checkpoint.revision },
        idempotencyKey,
      );
      return resumed.run;
    } catch (err) {
      const [latestRun, latestCheckpoint] = await Promise.all([
        getRun(flowId, run.id).catch(() => null),
        getActiveReviewCheckpoint(flowId, run.id).catch(() => null),
      ]);
      const checkpointMovedPastActiveReview =
        !latestCheckpoint ||
        (latestCheckpoint.id === checkpoint.id &&
          latestCheckpoint.state === "resumed");
      if (
        latestRun &&
        latestRun.status !== "awaiting_review" &&
        checkpointMovedPastActiveReview
      ) {
        return latestRun;
      }
      throw err;
    }
  }

  async function onSaveEdit(
    checkpoint: FlowRunReviewCheckpointPublic,
    editedValue: ReviewEditedValue,
  ): Promise<FlowRunReviewCheckpointPublic | null> {
    setRunError(null);
    try {
      const updated = await editReviewCheckpoint(
        flowId,
        checkpoint.flow_run_id,
        checkpoint.id,
        {
          expected_checkpoint_revision: checkpoint.revision,
          // Stegets output i sig (text-sträng eller JSON-värde), inte payload-kuvertet.
          edited_value: editedValue,
        },
      );
      setRun((prev) =>
        prev.kind === "awaiting_review"
          ? { ...prev, checkpoint: updated }
          : prev,
      );
      return updated;
    } catch (err) {
      setRunError(friendlyError(err));
      // Vid t.ex. stale revision: hämta aktuell checkpoint så UI:t synkar om
      // formuläret mot serverns version innan användaren försöker igen.
      const latest = await getActiveReviewCheckpoint(
        flowId,
        checkpoint.flow_run_id,
      ).catch(() => null);
      if (latest && latest.id === checkpoint.id) {
        setRun((prev) =>
          prev.kind === "awaiting_review"
            ? { ...prev, checkpoint: latest }
            : prev,
        );
      }
      return null;
    }
  }

  async function onReject(
    checkpoint: FlowRunReviewCheckpointPublic,
    runState: { run: FlowRunPublic; steps: FlowRunStep[] },
    reason: string,
  ) {
    setRunError(null);
    try {
      await rejectReviewCheckpoint(flowId, runState.run.id, checkpoint.id, {
        expected_checkpoint_revision: checkpoint.revision,
        reason,
      });
      // Run blir cancelled — hämta uppdaterat tillstånd och gå till "done".
      const r = await getRun(flowId, runState.run.id);
      setRun({ kind: "done", run: r, steps: runState.steps });
    } catch (err) {
      setRunError(friendlyError(err));
    }
  }

  async function fetchSignedUrls(runId: string, files: ResultFileRef[]) {
    const entries = await Promise.all(
      files.map(async (a) => {
        try {
          const r = await getArtifactSignedUrl(flowId, runId, a.file_id);
          return [a.file_id, { url: r.url }] as const;
        } catch {
          return null;
        }
      }),
    );
    const map: Record<string, { url: string }> = {};
    for (const e of entries) {
      if (e) map[e[0]] = e[1];
    }
    setSignedUrls(map);
  }

  function onRunAgain() {
    pollAbortRef.current.aborted = true;
    pollAbortRef.current = { aborted: false };
    setSignedUrls({});
    setRunError(null);
    writeRunIdToUrl(null);
    setRun({ kind: "idle" });
  }

  function onCancelSubmission() {
    submitAbortRef.current?.abort();
    submitAbortRef.current = null;
    setSubmission({ kind: "idle" });
    setRun({ kind: "idle" });
  }

  if (loadError) return <FlowUnavailable error={loadError} />;
  if (!published || !contract) return <FlowSkeleton />;

  const outputType = graph ? getFlowOutputType(graph) : null;
  const isTextual = isTextualOutput(outputType);

  if (run.kind === "idle") {
    return (
      <FlowInput
        published={published}
        contract={contract}
        input={input}
        ownerId={user.id}
        notice={runError}
        resumableRuns={resumableRuns}
        onResume={resumeRun}
        unsentRecordings={unsentRecordings}
      />
    );
  }

  if (run.kind === "running" || run.kind === "submitting") {
    return (
      <RecordingView
        published={published}
        run={run.kind === "running" ? run.run : undefined}
        steps={run.kind === "running" ? run.steps : []}
        stepLabels={stepLabels}
        submission={submission}
        onCancelSubmission={onCancelSubmission}
      />
    );
  }

  if (run.kind === "awaiting_review") {
    return (
      <ReviewView
        flowId={flowId}
        published={published}
        checkpoint={run.checkpoint}
        runState={{ run: run.run, steps: run.steps }}
        runError={runError}
        onApprove={(cp) =>
          onApproveAndResume(cp, { run: run.run, steps: run.steps })
        }
        onSaveEdit={onSaveEdit}
        onReject={(cp, reason) =>
          onReject(cp, { run: run.run, steps: run.steps }, reason)
        }
      />
    );
  }

  return (
    <NotesView
      flowId={flowId}
      published={published}
      runState={run}
      signedUrls={signedUrls}
      outputType={outputType}
      isTextual={isTextual}
      onRunAgain={onRunAgain}
      stepLabels={stepLabels}
    />
  );
}


// ---------- NavBar ----------

function NavBar({
  title,
  back = "/flows",
}: {
  title: string;
  back?: string;
}) {
  return (
    <nav className="flex items-center justify-between px-5 md:px-8 pt-4 md:pt-6 pb-2">
      <Link
        href={back}
        aria-label="Tillbaka"
        className="grid h-[42px] w-[42px] place-items-center rounded-full bg-paper border border-rule-soft text-ink transition-transform active:scale-95 shrink-0"
      >
        <ChevronLeft
          strokeWidth={2}
          style={{ width: 20, height: 20 }}
        />
      </Link>
      <div className="truncate px-3 text-[15px] md:text-[16px] font-semibold text-ink">
        {title}
      </div>
      <div className="shrink-0">
        <AccountMenu />
      </div>
    </nav>
  );
}

// ---------- Recording (post-submit, pre-result) ----------

function RecordingView({
  published,
  run,
  steps,
  stepLabels,
  submission,
  onCancelSubmission,
}: {
  published: FlowPublished;
  run?: FlowRunPublic;
  steps: FlowRunStep[];
  stepLabels: Record<string, string>;
  submission: SubmissionState;
  onCancelSubmission: () => void;
}) {
  const isUploading = submission.kind === "uploading";
  return (
    <>
      <div className="px-5 md:px-8 pt-4 md:pt-6">
        <OfflineBanner waiting={run ? "run" : "upload"} />
      </div>
      <header className="flex items-center justify-between px-5 md:px-8 pb-2">
        <div className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.18em] uppercase text-primary">
          <span
            aria-hidden
            className="lyssna-live-pulse h-1.5 w-1.5 rounded-full bg-primary"
          />
          Bearbetar
        </div>
        <div className="font-mono text-[10px] tracking-wider text-ink-mute">
          v{published.published_version}
        </div>
      </header>

      <div className="flex-1 flex flex-col items-center justify-center px-6 md:px-8 py-8 rec-bg">
        <div className="text-center mb-8 md:mb-10 w-full max-w-2xl">
          <div className="text-[19px] md:text-[28px] font-semibold tracking-[-0.015em] leading-tight">
            {published.name}
          </div>
          <div className="font-mono text-[10px] md:text-[11px] tracking-[0.14em] uppercase text-ink-mute mt-1.5 md:mt-2">
            {isUploading
              ? "Laddar upp ljudfil…"
              : submission.kind === "starting"
                ? "Startar flöde…"
                : run
                  ? labelForRunStatus(run.status)
                  : "Skickar…"}
          </div>
        </div>

        {isUploading ? (
          <UploadProgressCard
            submission={submission}
            onCancel={onCancelSubmission}
          />
        ) : (
          <div className="grid place-items-center mb-7 md:mb-10 w-full max-w-[340px] md:max-w-lg">
            <Loader2 className="h-9 w-9 md:h-12 md:w-12 animate-spin text-primary" />
            {submission.kind === "starting" && <RetryNotice wait={submission.wait} />}
          </div>
        )}

        <div className="w-full max-w-[300px] md:max-w-lg lg:max-w-xl paper-card p-4 md:p-6 lg:p-7">
          <div className="font-mono text-[9px] md:text-[10px] tracking-[0.16em] uppercase text-primary mb-2 md:mb-3 inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="lyssna-live-pulse h-1 w-1 rounded-full bg-primary"
            />
            Pågår
          </div>
          <StepProgress steps={steps} stepLabels={stepLabels} />
        </div>
      </div>
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
    <div className="w-full max-w-[340px] md:max-w-lg paper-card p-4 md:p-5 mb-7 md:mb-10">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="min-w-0">
          <div className="eyebrow-sm text-primary">Uppladdning</div>
          <div className="text-[14px] md:text-[15px] font-medium text-ink truncate mt-1">
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

function StepProgress({
  steps,
  stepLabels,
}: {
  steps: FlowRunStep[];
  stepLabels: Record<string, string>;
}) {
  if (steps.length === 0) {
    return (
      <p className="text-[14px] md:text-[16px] text-ink-soft leading-relaxed">
        Väntar på första steget…
        <span className="lyssna-blink text-primary ml-0.5">|</span>
      </p>
    );
  }
  return (
    <ol className="space-y-1.5 md:space-y-2.5">
      {steps.map((s, i) => {
        const status = s.status.toLowerCase();
        const success = SUCCESS_STATUSES.has(status);
        const failed = FAILURE_STATUSES.has(status);
        const running = status === "running" || status === "in_progress";
        const Icon = success
          ? CheckCircle2
          : failed
            ? XCircle
            : running
              ? Loader2
              : Circle;
        const iconClass = success
          ? "text-ink"
          : failed
            ? "text-primary"
            : running
              ? "text-primary animate-spin"
              : "text-ink-mute";
        return (
          <li
            key={s.id}
            className="flex items-start gap-2.5 md:gap-3.5 py-1 md:py-1.5"
          >
            <Icon
              className={`h-3.5 w-3.5 md:h-5 md:w-5 mt-0.5 md:mt-1 shrink-0 ${iconClass}`}
              strokeWidth={1.6}
            />
            <div className="flex-1 min-w-0">
              <div className="text-[13px] md:text-[16px] font-medium leading-snug md:leading-relaxed truncate md:whitespace-normal md:overflow-visible">
                <span className="text-ink-mute font-mono text-[10px] md:text-[12px] mr-1.5 md:mr-2">
                  {(i + 1).toString().padStart(2, "0")}
                </span>
                {(s.step_id && stepLabels[s.step_id]) ||
                  s.step_label ||
                  s.step_name ||
                  s.step_id}
              </div>
              <div className="text-[10px] md:text-[11px] font-mono uppercase tracking-wider text-ink-mute mt-0.5 md:mt-1">
                {labelForStepStatus(s.status)}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------- Review (human-in-the-loop pause) ----------

function ReviewView({
  flowId,
  published,
  checkpoint,
  runState,
  runError,
  onApprove,
  onSaveEdit,
  onReject,
}: {
  flowId: string;
  published: FlowPublished;
  checkpoint: FlowRunReviewCheckpointPublic;
  runState: { run: FlowRunPublic; steps: FlowRunStep[] };
  runError: string | null;
  onApprove: (cp: FlowRunReviewCheckpointPublic) => Promise<void>;
  onSaveEdit: (
    cp: FlowRunReviewCheckpointPublic,
    editedValue: ReviewEditedValue,
  ) => Promise<FlowRunReviewCheckpointPublic | null>;
  onReject: (cp: FlowRunReviewCheckpointPublic, reason: string) => Promise<void>;
}) {
  const payload = (checkpoint.current_payload_json as Json | null) ?? null;
  const isSpeakerMapping = isSpeakerMappingCheckpoint(payload);
  const participants = getSpeakerMappingParticipants(payload);
  const inferNames = getSpeakerMappingInferNames(payload);
  const proposals = useMemo(() => buildSpeakerRows(payload), [payload]);

  const initialText = extractCheckpointText(payload);
  const [text, setText] = useState<string>(initialText);
  const [speakerRows, setSpeakerRows] = useState<SpeakerMappingRow[]>(proposals);
  const [editing, setEditing] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [working, setWorking] = useState<"approve" | "reject" | null>(null);
  const [showReject, setShowReject] = useState<boolean>(false);
  const [rejectReason, setRejectReason] = useState<string>("");

  // Synka när checkpoint uppdateras (t.ex. efter PATCH eller omhämtning).
  useEffect(() => {
    setText(extractCheckpointText(payload));
    setSpeakerRows(buildSpeakerRows(payload));
  }, [checkpoint.revision, checkpoint.current_payload_json]);

  // Transkriberingsstegets segment, ordtider, ljudfiler och sparade
  // korrigeringar för spelaren.
  const playerRef = useRef<TranscriptPlayerHandle | null>(null);
  const runId = runState.run.id;
  const reverseNames = useMemo(() => proposalNameToLabel(proposals), [proposals]);
  const [transcript] = useTranscriptContext({
    flowId,
    runId,
    enabled: isSpeakerMapping,
    source: getSpeakerMappingSourceStep(payload),
    fallbackText: initialText,
    labelFor: (speaker) => reverseNames[speaker] ?? speaker,
  });
  // Bekräftade osäkra ord lagras lokalt per steg (ryms inte i Eneos modell).
  const [confirmedWords, toggleConfirmed] = useConfirmedWords(
    transcript.stepId ? confirmedWordsStorageKey(flowId, runId, transcript.stepId) : null,
  );

  const { corrections, saveState, localError, saveQueue, onCorrectionsChange, retryCorrections, downloadUnsavedCorrections } = useTranscriptCorrections(flowId, runId, transcript);

  // Fritextredigering är bara giltig för text-steg: Eneo kräver en sträng
  // som edited_value för `text` och ett JSON-värde för `json`. Speaker
  // mapping är json-steget vi redigerar strukturerat via talarrader.
  const editable =
    checkpoint.review_mode === "edit" &&
    !isSpeakerMapping &&
    (checkpoint.output_type == null || checkpoint.output_type === "text");
  const textDirty = editing && text !== initialText;
  const speakersDirty =
    isSpeakerMapping &&
    JSON.stringify(buildEditedMapping(speakerRows)) !==
      JSON.stringify(buildEditedMapping(proposals));
  const dirty = isSpeakerMapping ? speakersDirty : textDirty;

  const speakerNames = useMemo(() => speakerNamesFromRows(speakerRows), [speakerRows]);
  const unmapped = isSpeakerMapping ? unmappedSpeakerLabels(speakerRows) : [];
  const hasAudio = transcript.fileIds.length > 0 && transcript.segments.length > 0;
  const speakerLabels = useMemo(() => speakerRows.map((r) => r.label), [speakerRows]);

  function pendingEditedValue(): ReviewEditedValue {
    return isSpeakerMapping ? buildEditedMapping(speakerRows) : text;
  }

  function listenTo(label: string) {
    const target = firstSegmentForSpeaker(transcript.segments, label);
    if (!target) return;
    playerRef.current?.seekTo(target.fileIndex, target.time, true);
  }

  async function saveAndApprove() {
    setWorking("approve");
    // Pågående korrigeringssparningar måste landa före godkännandet, som
    // viker in dem i transkriptet. Misslyckades senaste sparningen: stanna.
    const correctionsSaved = await saveQueue.current;
    if (!correctionsSaved || (isSpeakerMapping && (transcript.pending || transcript.correctionProblem))) {
      setWorking(null);
      return;
    }
    let cp = checkpoint;
    if (dirty) {
      setSaving(true);
      const updated = await onSaveEdit(checkpoint, pendingEditedValue());
      setSaving(false);
      if (!updated) {
        setWorking(null);
        return;
      }
      cp = updated;
    }
    try {
      await onApprove(cp);
    } finally {
      setWorking(null);
    }
  }

  async function saveOnly() {
    if (!dirty) return;
    setSaving(true);
    await onSaveEdit(checkpoint, pendingEditedValue());
    setSaving(false);
    setEditing(false);
  }

  async function submitReject() {
    if (!rejectReason.trim()) return;
    setWorking("reject");
    try {
      await onReject(checkpoint, rejectReason.trim());
    } finally {
      setWorking(null);
    }
  }

  const busy = working !== null || saving;
  const canCorrect =
    isSpeakerMapping && transcript.fromMetadata && transcript.stepId !== null && !busy;

  const rejectSection = showReject ? (
    <section className="paper-card p-4 mb-5">
      <div className="text-[13px] font-semibold text-ink mb-1">Avvisa körningen</div>
      <p className="text-[12px] text-ink-soft mb-3">
        Ange en kort motivering. Körningen kommer att avbrytas.
      </p>
      <textarea
        value={rejectReason}
        onChange={(e) => setRejectReason(e.target.value)}
        rows={3}
        placeholder="Skäl …"
        className="w-full text-[13px] p-3 rounded-lg border border-rule-soft bg-bg-2/40 focus:outline-none focus:border-ink/30 mb-3"
      />
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setShowReject(false);
            setRejectReason("");
          }}
          disabled={working === "reject"}
          className="text-[12px] text-ink-soft hover:text-ink px-3 py-1.5 transition-colors disabled:opacity-50"
        >
          Avbryt
        </button>
        <button
          type="button"
          onClick={submitReject}
          disabled={!rejectReason.trim() || working === "reject"}
          className="inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-4 py-2 text-[13px] font-medium disabled:opacity-50"
        >
          {working === "reject" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Bekräfta avvisning
        </button>
      </div>
    </section>
  ) : null;

  const actions = (
    <div className="mt-auto flex items-center justify-between gap-3 pt-4">
      <button
        type="button"
        onClick={() => setShowReject(true)}
        disabled={working !== null || showReject}
        className="text-[13px] text-ink-soft hover:text-primary transition-colors disabled:opacity-50"
      >
        Avvisa
      </button>
      <Button type="button" onClick={saveAndApprove} disabled={busy || (isSpeakerMapping && (transcript.pending || Boolean(transcript.correctionProblem)))}>
        {working === "approve" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <CheckCircle2 className="h-4 w-4" strokeWidth={2} />
        )}
        {dirty ? "Spara och fortsätt" : "Godkänn och fortsätt"}
      </Button>
    </div>
  );

  const header = (
    <header className="flex items-center justify-between px-5 md:px-8 pt-4 pb-2">
      <Link
        href="/flows"
        aria-label="Tillbaka"
        className="grid h-9 w-9 place-items-center rounded-full bg-paper border border-rule-soft text-ink transition-transform active:scale-95"
      >
        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
      </Link>
      <div className="text-[12px] text-ink-mute">
        Pausat i steg {checkpoint.step_order}
      </div>
      <div className="font-mono text-[10px] tracking-wider text-ink-mute">
        v{published.published_version}
      </div>
    </header>
  );

  if (isSpeakerMapping) {
    return (
      <>
        {header}
        <main className={`px-5 md:px-8 pt-2 pb-6 flex-1 flex flex-col w-full mx-auto ${SPEAKER_REVIEW_ENABLED ? "max-w-5xl" : "max-w-7xl"}`}>
          <h1 className="text-[24px] md:text-[30px] font-semibold tracking-[-0.025em] leading-[1.15] mb-1">
            {SPEAKER_REVIEW_ENABLED ? "Granska transkriptet" : "Vem är vem?"}
          </h1>
          <p className="text-[13px] text-ink-soft leading-relaxed mb-5 max-w-prose">
            {SPEAKER_REVIEW_ENABLED ? "Lyssna, markera ord och välj vem som säger dem. Du kan också rätta texten." : "Lyssna och sätt namn på talarna. Namnen skrivs in i transkriptet när du fortsätter."}
          </p>

          <div className={SPEAKER_REVIEW_ENABLED ? "grid gap-3" : "grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] xl:grid-cols-[minmax(0,5fr)_minmax(0,8fr)] lg:items-start"}>
            <details open={SPEAKER_REVIEW_ENABLED ? undefined : true} className="paper-card p-4">
              <summary className={SPEAKER_REVIEW_ENABLED ? "cursor-pointer text-[13px] font-medium" : "hidden"}>
                Talare <span className="ml-2 font-normal text-ink-mute">{speakerRows.map((row) => row.name || speakerDisplayLabel(row.label)).join(", ")}</span>
              </summary>
              {SPEAKER_REVIEW_ENABLED && <p className="mt-3 mb-4 text-[12px] text-ink-mute">Namn gäller för talaren i hela transkriptet. För att byta vem som säger vissa ord, markera orden nedan.</p>}
              {speakerRows.length === 0 ? (
                <p className="text-[13px] text-ink-soft">
                  Inga talare kunde urskiljas i transkriptet. Du kan fortsätta
                  utan att namnge någon.
                </p>
              ) : (
                <SpeakerMappingEditor
                  rows={speakerRows}
                  proposals={proposals}
                  participants={participants}
                  inferred={inferNames}
                  disabled={busy}
                  showSamples={!transcript.pending && !hasAudio}
                  onChange={setSpeakerRows}
                  onListen={hasAudio ? listenTo : undefined}
                  listenUnavailableReason={(label) => !firstSegmentForSpeaker(transcript.segments, label) ? "Det finns inget tilldelat exempel utan överlappande tal." : null}
                />
              )}
              {unmapped.length > 0 && speakerRows.length > 0 && (
                <p className="mt-3 text-[12px] text-ink-mute leading-snug">
                  Talare utan namn behåller sin etikett i transkriptet.
                </p>
              )}
            </details>

            <TranscriptPlayer
              ref={playerRef}
              className="paper-card overflow-hidden lg:min-h-[28rem] lg:max-h-[calc(100vh-14rem)]"
              segments={transcript.segments}
              speakerReviews={transcript.speakerReviews}
              correctionProblem={transcript.correctionProblem}
              fileCount={transcript.fileIds.length}
              audioSrcFor={(fileIndex) =>
                inputFileAudioUrl(flowId, runId, transcript.fileIds[fileIndex] ?? "")
              }
              speakerNames={speakerNames}
              textFallback={initialText}
              audioPending={transcript.pending}
              corrections={corrections}
              editable={canCorrect}
              onCorrectionsChange={onCorrectionsChange}
              speakerOptions={speakerLabels}
              saveState={saveState}
              confirmedWords={confirmedWords}
              onToggleConfirmed={toggleConfirmed}
            />
          </div>

          {(runError || localError) && (
            <p className="text-[13px] text-destructive mt-4" role="alert">
              {runError ?? localError}
            </p>
          )}
          {saveState === "error" && <div className="mt-2 flex gap-4 text-[13px]">
            <button type="button" className="underline" onClick={retryCorrections}>Försök spara igen</button>
            <button type="button" className="underline" onClick={downloadUnsavedCorrections}>Hämta osparade rättningar</button>
          </div>}
          <div className="mt-4">{rejectSection}</div>
          {actions}
        </main>
      </>
    );
  }

  return (
    <>
      {header}
      <main className="px-6 md:px-8 pt-2 md:pt-4 pb-6 flex-1 flex flex-col w-full mx-auto max-w-3xl">
        <h1 className="text-[24px] md:text-[30px] font-semibold tracking-[-0.025em] leading-[1.15] mb-1">
          {checkpoint.step_label ?? "Granska resultatet"}
        </h1>
        <p className="text-[13px] text-ink-soft leading-relaxed mb-5">
          {editable
            ? "Du kan ändra texten innan du godkänner och fortsätter."
            : "Granska innehållet och välj om flödet ska fortsätta."}
        </p>

        <section className="paper-card p-4 mb-5">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[13px] font-semibold text-ink">Innehåll för granskning</div>
            <div className="text-[11px] text-ink-mute">
              {editable ? "Redigerbart" : "Skrivskyddat"}
            </div>
          </div>

          {editable && editing ? (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={Math.min(24, Math.max(8, text.split("\n").length + 1))}
              className="w-full text-[14px] md:text-[15px] leading-relaxed p-3 md:p-4 rounded-lg border border-rule-soft bg-bg-2/40 focus:outline-none focus:border-ink/30 font-sans"
            />
          ) : (
            <article className="prose prose-sm md:prose-base max-w-none text-[14px] md:text-[15px] leading-relaxed">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
            </article>
          )}

          {editable && (
            <div className="flex items-center justify-end gap-2 mt-3">
              {editing ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setText(initialText);
                      setEditing(false);
                    }}
                    disabled={saving}
                    className="text-[12px] text-ink-soft hover:text-ink px-3 py-1.5 transition-colors disabled:opacity-50"
                  >
                    Avbryt
                  </button>
                  <button
                    type="button"
                    onClick={saveOnly}
                    disabled={!dirty || saving}
                    className="inline-flex items-center gap-1.5 rounded-full bg-paper border border-rule-soft text-ink px-3.5 py-1.5 text-[12px] font-medium disabled:opacity-50"
                  >
                    {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    Spara ändring
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="text-[12px] text-ink-soft hover:text-ink px-3 py-1.5 transition-colors"
                >
                  Redigera
                </button>
              )}
            </div>
          )}
        </section>

        {runError && (
          <p className="text-[13px] text-destructive mb-3" role="alert">
            {runError}
          </p>
        )}
        {rejectSection}
        {actions}
      </main>
    </>
  );
}

function extractCheckpointText(payload: Json | null | undefined): string {
  if (!payload) return "";
  const text = (payload as { text?: unknown }).text;
  if (typeof text === "string") return text;
  // Fallback: visa payloaden som JSON så användaren ändå kan granska.
  try {
    return "```json\n" + JSON.stringify(payload, null, 2) + "\n```";
  } catch {
    return "";
  }
}

// ---------- Notes (result) ----------

function NotesView({
  flowId,
  published,
  runState,
  signedUrls,
  outputType,
  isTextual,
  onRunAgain,
  stepLabels,
}: {
  flowId: string;
  published: FlowPublished;
  runState: { kind: "done"; run: FlowRunPublic; steps: FlowRunStep[] };
  signedUrls: Record<string, { url: string }>;
  outputType: string | null;
  isTextual: boolean;
  onRunAgain: () => void;
  stepLabels: Record<string, string>;
}) {
  const { run, steps } = runState;
  const { text, note } = runResultView(run.result);
  const failure = run.error ? runErrorView(run.error, stepLabels) : null;
  const success = isSuccess(run.status);
  // Inspelning och transkript för körningar med ett transkriberingssteg.
  const [transcript] = useTranscriptContext({
    flowId,
    runId: run.id,
    enabled: success,
    steps,
  });
  const [confirmedWords] = useConfirmedWords(
    transcript.stepId ? confirmedWordsStorageKey(flowId, run.id, transcript.stepId) : null,
  );
  const { corrections, saveState, localError, onCorrectionsChange, retryCorrections, downloadUnsavedCorrections } = useTranscriptCorrections(flowId, run.id, transcript);
  const showPlayer = success && !transcript.pending && (transcript.segments.length > 0 || transcript.speakerReviews.length > 0);
  const outputLabel = labelForOutputType(outputType);
  const finishedDate = run.finished_at
    ? new Date(run.finished_at).toLocaleDateString("sv-SE", {
        day: "numeric",
        month: "long",
      })
    : null;
  const fileCount = run.result_files?.length ?? 0;

  return (
    <>
      <NavBar title={`Klar · ${labelForRunStatus(run.status).toLowerCase()}`} />

      <div className="px-6 md:px-8 pt-2 md:pt-4 pb-5 w-full mx-auto max-w-3xl">
        <h1 className="text-[26px] md:text-[32px] font-semibold tracking-[-0.025em] leading-[1.15] mb-2.5">
          {published.name}
        </h1>
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 font-mono text-[10px] tracking-wider uppercase text-ink-mute">
          {finishedDate && (
            <span className="after:content-['·'] after:ml-3.5 after:text-rule last:after:hidden">
              {finishedDate}
            </span>
          )}
          <span className="after:content-['·'] after:ml-3.5 after:text-rule last:after:hidden">
            v{published.published_version}
          </span>
          {fileCount > 0 && (
            <span className="after:content-['·'] after:ml-3.5 after:text-rule last:after:hidden">
              {fileCount} {fileCount === 1 ? "fil" : "filer"}
            </span>
          )}
        </div>
      </div>

      <div className="px-6 md:px-8 pb-6 flex-1 w-full mx-auto max-w-3xl">
        {failure && (
          <div className="paper-card p-4 mb-4 border-primary/30">
            <div className="eyebrow-sm text-primary mb-1">
              {failure.step ? `Fel · ${failure.step}` : "Fel"}
            </div>
            <p className="text-[14px] text-ink">{failure.summary}</p>
            <details className="mt-2 text-[12px] text-ink-soft">
              <summary className="min-h-6 cursor-pointer">Teknisk detalj</summary>
              <p className="mt-1 whitespace-pre-wrap break-words">{failure.detail}</p>
              <p className="mt-1 font-mono text-ink-mute">
                {run.error?.code} · körnings-ID {run.id}
              </p>
            </details>
          </div>
        )}

        {note && <p className="text-[14px] text-ink-soft mb-2">{note}</p>}

        {success && text && (
          <article
            className="
              prose prose-stone max-w-none
              prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-ink
              prose-h1:text-[22px] prose-h2:text-[18px] prose-h3:text-[15px]
              prose-p:text-[14px] prose-p:leading-[1.6] prose-p:text-ink
              prose-li:text-[14px] prose-li:leading-[1.55] prose-li:text-ink
              prose-strong:text-ink prose-strong:font-semibold
              prose-em:text-ink-soft prose-em:not-italic
              prose-a:text-primary prose-a:no-underline hover:prose-a:underline
              prose-code:font-mono prose-code:text-[12px]
              prose-code:before:hidden prose-code:after:hidden
              prose-code:bg-bg-2 prose-code:px-1 prose-code:py-0.5 prose-code:rounded
              prose-pre:bg-ink prose-pre:text-paper prose-pre:rounded-xl
              prose-blockquote:not-italic prose-blockquote:text-ink-soft prose-blockquote:border-primary prose-blockquote:font-normal
              prose-table:text-[13px]
              prose-hr:border-rule-soft
            "
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </article>
        )}

        {/* För binär output (DOCX/PDF/etc): liten beskrivning ovanför fil-listan */}
        {success && !isTextual && fileCount > 0 && outputLabel && (
          <p className="text-[14px] text-ink-soft mb-2">
            Det här flödet skapade ett <span className="text-ink">{outputLabel}</span>
            {fileCount === 1 ? "" : ` (${fileCount} filer)`}.
          </p>
        )}

        {!success && !run.error && (
          <p className="text-[14px] text-ink-soft">
            Körningen avslutades med status:{" "}
            <span className="text-ink">{labelForRunStatus(run.status)}</span>.
          </p>
        )}

        {showPlayer && (
          <section className={text ? "mt-6" : ""}>
            <div className="mb-2.5 text-[13px] font-semibold text-ink">
              Inspelning och transkript
            </div>
            {(saveState !== "idle" || (corrections.updatedAt && run.finished_at && Date.parse(corrections.updatedAt) > Date.parse(run.finished_at))) && <p className="mb-2 text-[13px]">Sammanfattningen och tidigare skapade filer uppdateras inte av rättningarna. Hämta det granskade transkriptet som underlag för en ny sammanfattning.</p>}
            {localError && <p role="alert" className="text-primary">{localError}</p>}
            {saveState === "error" && <div className="flex gap-4 text-[13px]">
              <button type="button" className="underline" onClick={retryCorrections}>Försök spara igen</button>
              <button type="button" className="underline" onClick={downloadUnsavedCorrections}>Hämta osparade rättningar</button>
            </div>}
            <TranscriptPlayer
              className="paper-card overflow-hidden max-h-[36rem]"
              segments={transcript.segments}
              speakerReviews={transcript.speakerReviews}
              correctionProblem={transcript.correctionProblem}
              fileCount={transcript.fileIds.length}
              audioSrcFor={(fileIndex) =>
                inputFileAudioUrl(flowId, run.id, transcript.fileIds[fileIndex] ?? "")
              }
              speakerNames={transcript.speakerNames}
              textFallback=""
              corrections={corrections}
              editable={transcript.fromMetadata && !transcript.pending}
              onCorrectionsChange={onCorrectionsChange}
              saveState={saveState}
              confirmedWords={confirmedWords}
            />
          </section>
        )}

        {fileCount > 0 && (
          <section className={isTextual ? "mt-6" : ""}>
            <div className="flex items-center justify-between mb-2.5">
              <div className="eyebrow-sm">Genererade filer</div>
              <div className="bg-ink text-paper px-2 py-0.5 rounded-full text-[9px] font-mono tracking-wider">
                {fileCount}
              </div>
            </div>
            <ul className="divide-y divide-rule-soft">
              {run.result_files!.map((a) => {
                const url = signedUrls[a.file_id]?.url;
                const name = a.name || a.file_id;
                return (
                  <li
                    key={a.file_id}
                    className="flex items-center justify-between py-3"
                  >
                    <div className="flex-1 min-w-0 pr-3">
                      <div className="text-[14px] truncate">{name}</div>
                      {a.size != null && (
                        <div className="text-[11px] text-ink-mute mt-0.5 font-mono">
                          {formatBytes(a.size)}
                        </div>
                      )}
                    </div>
                    {url ? (
                      <a
                        href={url}
                        download={name}
                        className="inline-flex items-center gap-2 rounded-full bg-ink text-paper px-4 py-2 text-[13px] font-medium tracking-tight shadow-sm transition-all hover:bg-ink/90 active:scale-[0.97] shrink-0"
                      >
                        <Download className="h-4 w-4" strokeWidth={2} />
                        Ladda ner
                      </a>
                    ) : a.availability === "content_purged" ? (
                      <span className="rounded-full border border-rule-soft bg-bg-2/50 text-ink-mute px-4 py-2 text-[13px] font-mono tracking-wider shrink-0">
                        borttagen
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-2 rounded-full border border-rule-soft bg-bg-2/50 text-ink-mute px-4 py-2 text-[13px] font-mono tracking-wider shrink-0">
                        <span
                          aria-hidden
                          className="inline-block h-1.5 w-1.5 rounded-full bg-ink-mute lyssna-live-pulse"
                        />
                        genererar
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {steps.length > 0 && (
          <details className="paper-card p-4 mt-6">
            <summary className="cursor-pointer eyebrow-sm hover:text-ink transition-colors">
              Visa stegdetaljer · {steps.length}
            </summary>
            <div className="mt-3">
              <StepProgress steps={steps} stepLabels={stepLabels} />
            </div>
          </details>
        )}
      </div>

      <footer className="sticky bottom-0 px-5 md:px-8 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] border-t border-rule-soft bg-paper">
        <div className="flex gap-2.5 w-full mx-auto max-w-3xl">
          <Button
            type="button"
            variant="secondary"
            onClick={onRunAgain}
            className="flex-1"
          >
            <Share2 className="h-3.5 w-3.5" strokeWidth={1.8} />
            Kör igen
          </Button>
          <Button asChild className="flex-[1.6]">
            <Link href="/flows">
              <Send className="h-3.5 w-3.5" strokeWidth={1.8} />
              Klart
            </Link>
          </Button>
        </div>
      </footer>
    </>
  );
}

// ---------- Helpers ----------

const SUCCESS_STATUSES = new Set(["succeeded", "completed", "success", "done"]);
const FAILURE_STATUSES = new Set(["failed", "error", "errored"]);
const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "aborted"]);
// "awaiting_review" är ett non-terminal status i nya Eneo-specen (human-in-the-loop).
// Pollingen behöver inte ändras — men när vi bygger UI för review checkpoints
// ska vi sluta visa "kör" och istället visa pending review.

function isSuccess(status: string): boolean {
  return SUCCESS_STATUSES.has(status.toLowerCase());
}

function isTerminal(status: string): boolean {
  const s = status.toLowerCase();
  return (
    SUCCESS_STATUSES.has(s) ||
    FAILURE_STATUSES.has(s) ||
    CANCELLED_STATUSES.has(s)
  );
}

function labelForRunStatus(status: string): string {
  const s = status.toLowerCase();
  if (SUCCESS_STATUSES.has(s)) return "Lyckades";
  if (FAILURE_STATUSES.has(s)) return "Misslyckades";
  if (CANCELLED_STATUSES.has(s)) return "Avbröts";
  if (s === "running" || s === "in_progress") return "Bearbetar…";
  if (s === "queued" || s === "pending") return "I kö";
  return status;
}

function labelForOutputType(outputType: string | null | undefined): string | null {
  if (!outputType) return null;
  const t = outputType.toLowerCase();
  switch (t) {
    case "docx":
      return "Word-dokument (DOCX)";
    case "pdf":
      return "PDF-dokument";
    case "xlsx":
      return "Excel-dokument (XLSX)";
    case "pptx":
      return "PowerPoint-dokument (PPTX)";
    case "image":
    case "png":
    case "jpg":
    case "jpeg":
      return "Bild";
    case "audio":
      return "Ljudfil";
    case "video":
      return "Videofil";
    case "text":
    case "markdown":
      return "Text";
    case "json":
      return "JSON-data";
    default:
      return outputType.toUpperCase();
  }
}

function labelForStepStatus(status: string): string {
  const s = status.toLowerCase();
  if (SUCCESS_STATUSES.has(s)) return "Klar";
  if (FAILURE_STATUSES.has(s)) return "Misslyckades";
  if (CANCELLED_STATUSES.has(s)) return "Avbruten";
  if (s === "running" || s === "in_progress") return "Kör…";
  if (s === "queued" || s === "pending") return "I kö";
  return status;
}
