"use client";

import { useTranscriptCorrections } from "@/components/useTranscriptCorrections";

import Link from "next/link";
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  FileAudio,
  Info,
  Loader2,
  Upload,
  Users,
} from "lucide-react";
import { SPEAKER_REVIEW_ENABLED } from "@/lib/speaker-review";
import { use, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AuthGate } from "@/components/AuthGate";
import { AccountMenu } from "@/components/AccountMenu";
import { AudioRecorder } from "@/components/AudioRecorder";
import { OfflineBanner } from "@/components/OfflineBanner";
import { RetryNotice } from "@/components/RetryNotice";
import {
  ApiError,
  approveReviewCheckpoint,
  cancelRun,
  editReviewCheckpoint,
  getActiveReviewCheckpoint,
  getFlowGraph,
  getFlowOutputType,
  getPublishedFlow,
  getRun,
  getRunContract,
  getRunSteps,
  inputFileAudioUrl,
  isReviewCheckpointApproved,
  listRuns,
  rejectReviewCheckpoint,
  resumeReviewCheckpoint,
  reviewResumeIdempotencyKey,
  speakerMappingReviewSteps,
  startRun,
  type FlowGraph,
  type FlowPublished,
  type FlowRunPublic,
  type FlowRunReviewCheckpointPublic,
  type FlowRunStep,
  type FlowRunSummary,
  type FormField,
  type Json,
  type ReviewEditedValue,
  type RunContract,
} from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { onlineStatus } from "@/lib/online-status";
import { retryFailedRun, startAgainRequest, submitRun, withRetry, type RetryWait } from "@/lib/submit-run";
import { followRun, VISIBLE_POLL_MS } from "@/lib/follow-run";
import { runOutcome, runStage, runSteps } from "@/lib/run-progress";
import { RunOpening, RunProgress } from "@/components/flow/RunProgress";
import { runErrorView } from "@/lib/run-result";
import { resultFileViews } from "@/lib/run-files";
import { EarlierRuns } from "@/components/flow/EarlierRuns";
import { RunFailure } from "@/components/flow/RunFailure";
import { RunResult } from "@/components/flow/RunResult";
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
import {
  formatBytes,
  isMimeAllowed,
  isRuntimeFileInput,
  selectRuntimeInputStep,
} from "@/lib/upload";

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
  // An earlier run is being read; its state is not known yet.
  | { kind: "opening" }
  | { kind: "running"; run: Pick<FlowRunSummary, "id" | "status">; graph: FlowGraph | null }
  | {
      kind: "awaiting_review";
      run: FlowRunPublic;
      steps: FlowRunStep[];
      checkpoint: FlowRunReviewCheckpointPublic;
    }
  | { kind: "done"; run: FlowRunPublic; steps: FlowRunStep[]; graph: FlowGraph | null };

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

// Körningens id ligger i URL:en (?run=…) så att en omladdning, eller en
// delad länk, kan återuppta samma körning i stället för att tappa den.
const RUN_QUERY_PARAM = "run";

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [file, setFile] = useState<{ blob: Blob; filename: string } | null>(
    null,
  );
  const [run, setRun] = useState<RunState>({ kind: "idle" });
  const [submission, setSubmission] = useState<SubmissionState>({
    kind: "idle",
  });
  const [recordingActive, setRecordingActive] = useState(false);
  const [earlierRuns, setEarlierRuns] = useState<FlowRunSummary[]>([]);
  // Why Eneo would not continue the failed run on screen, and whether a new run is the way on.
  const [retryRefusal, setRetryRefusal] = useState<{ message: string; startAgain: boolean } | null>(null);

  const followAbortRef = useRef<AbortController | null>(null);
  const submitAbortRef = useRef<AbortController | null>(null);

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
        const defaults: Record<string, string> = {};
        for (const f of c.form_fields ?? []) {
          if (f.default != null) defaults[f.name] = String(f.default);
        }
        setFormValues(defaults);

        // Återuppta körningen i URL:en (t.ex. efter omladdning mitt i en
        // granskning). Annars: visa flödets senaste körningar.
        const urlRunId = readRunIdFromUrl();
        if (urlRunId) resumeRun(urlRunId);
        else loadEarlierRuns();
      })
      .catch((err) => {
        if (cancelled) return;
        // Unpublished between the list and here: module-redesign's FlowUnavailable
        // says the same and replaces this view at integration.
        const gone = err instanceof ApiError && (err.status === 404 || err.code === "flow_not_published");
        setLoadError(gone ? "Flödet är inte längre tillgängligt." : friendlyError(err));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId]);

  useEffect(() => {
    return () => {
      followAbortRef.current?.abort();
      submitAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const shouldWarn = recordingActive || submission.kind !== "idle";
    if (!shouldWarn) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [recordingActive, submission.kind]);

  const runtimeInput = useMemo(
    () => selectRuntimeInputStep(contract),
    [contract],
  );
  const inputType = runtimeInput?.input_format;
  const acceptsUpload = !!runtimeInput && isRuntimeFileInput(inputType);
  const acceptedMimetypes = runtimeInput?.accepted_mimetypes ?? [];
  const maxFileSizeBytes = runtimeInput?.max_file_size_bytes;

  const requiresFile = acceptsUpload && runtimeInput?.required !== false;

  const formFields = contract?.form_fields ?? [];

  const canSubmit = useMemo(() => {
    if (run.kind !== "idle") return false;
    if (!contract) return false;
    if (requiresFile && !file) return false;
    for (const f of formFields) {
      if (f.required) {
        const v = formValues[f.name];
        if (!v || v.trim().length === 0) return false;
      }
    }
    return true;
  }, [run.kind, contract, requiresFile, file, formFields, formValues]);

  function setField(key: string, value: string) {
    setFormValues((prev) => ({ ...prev, [key]: value }));
  }

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) {
      setFile(null);
      return;
    }
    if (maxFileSizeBytes && f.size > maxFileSizeBytes) {
      setRunError(
        `Filen är för stor (${formatBytes(f.size)}). Max: ${formatBytes(maxFileSizeBytes)}.`,
      );
      e.target.value = "";
      return;
    }
    if (f.type && !isMimeAllowed(f.type, acceptedMimetypes)) {
      setRunError(
        `Filtypen "${f.type}" stöds inte. Tillåtna: ${acceptedMimetypes.join(", ")}.`,
      );
      e.target.value = "";
      return;
    }
    setRunError(null);
    setFile({ blob: f, filename: f.name });
  }

  async function onRecorded(blob: Blob | null, fname: string | null) {
    if (blob && fname) setFile({ blob, filename: fname });
    else setFile(null);
  }

  async function onRun() {
    if (!contract) return;
    setRunError(null);
    setRun({ kind: "submitting" });
    setSubmission({ kind: "idle" });
    const abortController = new AbortController();
    submitAbortRef.current = abortController;

    try {
      const initialRun = await submitRun({
        flowId,
        contract,
        stepId: runtimeInput?.step_id ?? null,
        files: file ? [file] : [],
        inputPayload: formPayload(formFields, formValues),
        online: onlineStatus,
        signal: abortController.signal,
        onProgress: (progress) =>
          setSubmission({ kind: "uploading", ...progress, wait: null }),
        onStarting: () => setSubmission({ kind: "starting", wait: null }),
        onWait: (wait) =>
          setSubmission((prev) => (prev.kind === "idle" ? prev : { ...prev, wait })),
      });
      submitAbortRef.current = null;
      setSubmission({ kind: "idle" });

      writeRunIdToUrl(initialRun.id);
      setRun({ kind: "running", run: initialRun, graph: null });
      void follow(initialRun.id);
    } catch (err) {
      setRunError(friendlyError(err));
      setRun({ kind: "idle" });
      setSubmission({ kind: "idle" });
      submitAbortRef.current = null;
    }
  }

  /** Flödets tio senaste körningar; listan är en genväg och får saknas. */
  function loadEarlierRuns() {
    listRuns(flowId, 10)
      .then((res) => setEarlierRuns(res.items ?? []))
      .catch(() => undefined);
  }

  /** Plockar upp en befintlig körning (från URL eller listan) och följer den. */
  function resumeRun(runId: string) {
    setRunError(null);
    setRetryRefusal(null);
    writeRunIdToUrl(runId);
    setRun({ kind: "opening" });
    void follow(runId);
  }

  /**
   * Följer körningen via dess status och den körningslåsta grafen tills den
   * är klar eller väntar på granskning. Stegresultaten (en auditloggad läsning)
   * och detaljen hämtas en gång, när körningen är klar.
   */
  async function follow(runId: string) {
    followAbortRef.current?.abort();
    const controller = new AbortController();
    followAbortRef.current = controller;
    const { signal } = controller;
    try {
      const last = await followRun(flowId, runId, {
        signal,
        onSnapshot: ({ run: current, graph: runGraph }) => {
          if (runOutcome(current.status) || current.status === "awaiting_review") return;
          setRun({ kind: "running", run: current, graph: runGraph });
        },
      });
      if (!last || signal.aborted) return;
      if (last.run.status === "awaiting_review") {
        const checkpoint = await getActiveReviewCheckpoint(flowId, runId).catch(() => null);
        if (signal.aborted) return;
        if (checkpoint) {
          // Pausad tills användaren agerat; granskningsvyn startar följningen igen.
          setRun({ kind: "awaiting_review", run: last.run as FlowRunPublic, steps: [], checkpoint });
        } else {
          // Checkpointen syns strax efter statusen; läs igen om en stund.
          setTimeout(() => !signal.aborted && void follow(runId), VISIBLE_POLL_MS);
        }
        return;
      }
      const [detail, steps] = await Promise.all([
        getRun(flowId, runId).catch(() => last.run as FlowRunPublic),
        getRunSteps(flowId, runId).catch(() => [] as FlowRunStep[]),
      ]);
      if (signal.aborted) return;
      setRun({ kind: "done", run: detail, steps, graph: last.graph });
    } catch (err) {
      if (signal.aborted) return;
      setRunError(friendlyError(err));
      setRun({ kind: "idle" });
    }
  }

  async function onCancelRun(runId: string) {
    setRunError(null);
    try {
      await cancelRun(flowId, runId);
    } catch (err) {
      setRunError(friendlyError(err));
      return;
    }
    // Läs den avbrutna körningen direkt i stället för vid nästa läsning.
    void follow(runId);
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
      // Följ körningen igen — den är nu i "running".
      setRun({ kind: "running", run: resumedRun, graph: null });
      void follow(resumedRun.id);
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
      // Körningen avbryts; följ den till slutet så att stegen och resultatet läses som vanligt.
      void follow(runState.run.id);
    } catch (err) {
      setRunError(friendlyError(err));
    }
  }

  /** Ny inspelning: samma flöde och uppgifter (deltagarna), men inget gammalt ljud. */
  function onRunAgain() {
    followAbortRef.current?.abort();
    setRunError(null);
    setRetryRefusal(null);
    setFile(null);
    writeRunIdToUrl(null);
    setRun({ kind: "idle" });
    loadEarlierRuns();
  }

  /**
   * "Försök igen": Eneo fortsätter den misslyckade körningen från första
   * ofärdiga steget i en ny körning; det som blev klart görs inte om.
   */
  async function onRetry(failed: Extract<RunState, { kind: "done" }>) {
    setRunError(null);
    setRetryRefusal(null);
    const outcome = await retryFailedRun(flowId, failed.run.id);
    if (outcome.kind === "refused") {
      setRetryRefusal({ message: outcome.message, startAgain: outcome.startAgain });
      return;
    }
    writeRunIdToUrl(outcome.run.id);
    setRun({ kind: "running", run: outcome.run, graph: null });
    void follow(outcome.run.id);
  }

  /** En ny körning med samma ljud och uppgifter: efter en avbrytning, eller när Eneo inte kan fortsätta. */
  async function onStartAgain(
    failed: Extract<RunState, { kind: "done" }>,
    request: { body: Json; idempotencyKey: string },
  ) {
    setRunError(null);
    setRun({ kind: "submitting" });
    setSubmission({ kind: "starting", wait: null });
    try {
      const next = await withRetry(
        () => startRun(flowId, request.body, request.idempotencyKey),
        { online: onlineStatus, onWait: (wait) => setSubmission({ kind: "starting", wait }) },
      );
      setSubmission({ kind: "idle" });
      // A refusal that led here stays on the failure view until a new run exists.
      setRetryRefusal(null);
      writeRunIdToUrl(next.id);
      setRun({ kind: "running", run: next, graph: null });
      void follow(next.id);
    } catch (err) {
      setSubmission({ kind: "idle" });
      setRunError(friendlyError(err));
      setRun(failed);
    }
  }

  function onCancelSubmission() {
    submitAbortRef.current?.abort();
    submitAbortRef.current = null;
    setSubmission({ kind: "idle" });
    setRun({ kind: "idle" });
  }

  if (loadError) {
    return (
      <>
        <NavBar title="Fel" />
        <main className="px-6 py-4">
          <p className="text-destructive">{loadError}</p>
          <Link
            href="/flows"
            className="text-sm text-ink-soft underline mt-3 inline-block"
          >
            Tillbaka
          </Link>
        </main>
      </>
    );
  }

  if (!published || !contract) {
    return (
      <>
        <NavBar title="Laddar" />
        <main className="grid place-items-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-ink-mute" />
        </main>
      </>
    );
  }

  const outputType = graph ? getFlowOutputType(graph) : null;

  const phase: "setup" | "progress" | "review" | "notes" =
    run.kind === "done"
      ? "notes"
      : run.kind === "awaiting_review"
        ? "review"
        : run.kind === "idle"
          ? "setup"
          : "progress";

  if (phase === "setup") {
    return (
      <SetupView
        published={published}
        contract={contract}
        outputType={outputType}
        formValues={formValues}
        setField={setField}
        inputType={inputType}
        acceptsUpload={acceptsUpload}
        acceptedMimetypes={acceptedMimetypes}
        maxFileSizeBytes={maxFileSizeBytes}
        file={file}
        onFilePicked={onFilePicked}
        onRecorded={onRecorded}
        onRecordingChange={setRecordingActive}
        canSubmit={canSubmit}
        submitting={run.kind === "submitting"}
        onRun={onRun}
        runError={runError}
        earlierRuns={earlierRuns}
        onOpenRun={resumeRun}
      />
    );
  }

  if (run.kind === "opening") {
    return (
      <>
        <NavBar title={published.name} />
        <RunOpening />
      </>
    );
  }

  if (run.kind === "running") {
    const steps = runSteps(run.graph, run.run);
    return (
      <>
        <NavBar title={published.name} />
        <RunProgress
          steps={steps}
          stage={runStage(steps, run.run.status)}
          error={runError}
          onCancel={() => onCancelRun(run.run.id)}
        />
      </>
    );
  }

  if (run.kind === "submitting") {
    return (
      <RecordingView
        published={published}
        submission={submission}
        onCancelSubmission={onCancelSubmission}
      />
    );
  }

  if (phase === "review" && run.kind === "awaiting_review") {
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

  if (phase === "notes" && run.kind === "done") {
    // Den körningslåsta grafen namnger stegen; saknas den duger den publicerade.
    const pinned = run.graph ?? graph;
    const steps = runSteps(pinned, run.run, run.steps);
    const files = resultFileViews(run.run.result_files ?? []);
    const transcribed = !pinned || steps.some((step) => step.transcribes && step.state === "done");
    if (runOutcome(run.run.status) === "succeeded") {
      return (
        <>
          <NavBar title={published.name} />
          <RunResult
            flowId={flowId}
            flowName={published.name}
            run={run.run}
            steps={steps}
            stepResults={run.steps}
            files={files}
            showTranscript={transcribed}
            audio={inputType === "audio"}
            onNewRecording={onRunAgain}
          />
        </>
      );
    }
    const labels = Object.fromEntries((pinned?.nodes ?? []).map((node) => [node.id, node.label]));
    const failure = run.run.error ? runErrorView(run.run.error, labels) : null;
    // The same audio cannot help when the input itself has to change.
    const sameInputHelps = !failure?.inputMustChange;
    const cancelled = runOutcome(run.run.status) === "cancelled";
    const startAgain = sameInputHelps
      ? startAgainRequest(run.run, run.steps, contract, runtimeInput?.step_id ?? null)
      : null;
    return (
      <>
        <NavBar title={published.name} />
        <RunFailure
          flowId={flowId}
          flowName={published.name}
          run={run.run}
          failure={failure}
          steps={steps}
          stepResults={run.steps}
          files={files}
          showTranscript={transcribed}
          error={runError}
          refusal={retryRefusal}
          onRetry={sameInputHelps && !cancelled ? () => onRetry(run) : undefined}
          onStartAgain={startAgain ? () => onStartAgain(run, startAgain) : undefined}
        />
      </>
    );
  }

  return null;
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

// ---------- Setup ----------

function SetupView({
  published,
  contract,
  outputType,
  formValues,
  setField,
  inputType,
  acceptsUpload,
  acceptedMimetypes,
  maxFileSizeBytes,
  file,
  onFilePicked,
  onRecorded,
  onRecordingChange,
  canSubmit,
  submitting,
  onRun,
  runError,
  earlierRuns,
  onOpenRun,
}: {
  published: FlowPublished;
  contract: RunContract;
  outputType: string | null;
  formValues: Record<string, string>;
  setField: (k: string, v: string) => void;
  inputType?: string;
  acceptsUpload: boolean;
  acceptedMimetypes: string[];
  maxFileSizeBytes?: number;
  file: { blob: Blob; filename: string } | null;
  onFilePicked: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRecorded: (blob: Blob | null, fname: string | null) => void;
  onRecordingChange: (recording: boolean) => void;
  canSubmit: boolean;
  submitting: boolean;
  onRun: () => void;
  runError: string | null;
  earlierRuns: FlowRunSummary[];
  onOpenRun: (runId: string) => void;
}) {
  const formFields = contract.form_fields ?? [];
  const speakerMappingSteps = speakerMappingReviewSteps(contract);
  const [localFileUrl, setLocalFileUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setLocalFileUrl(null);
      return;
    }
    const url = URL.createObjectURL(file.blob);
    setLocalFileUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <>
      <NavBar title={published.name} />

      <div className="px-6 md:px-8 pt-2 md:pt-4 pb-6 flex-1 flex flex-col w-full mx-auto max-w-2xl">
        <OfflineBanner waiting={null} />
        <h1 className="text-[28px] md:text-[34px] font-semibold tracking-[-0.025em] leading-[1.1] mb-1.5">
          Förbered <span className="primary-em">ditt möte</span>
        </h1>
        <p className="text-[14px] text-ink-soft leading-relaxed mb-3">
          {published.description ||
            "Lite info hjälper Flöden att skräddarsy transkriptet."}
        </p>
        <div className="mb-6" />

        <div className="flex items-center gap-4 rounded-2xl border border-ochre/40 bg-ochre/10 pl-5 pr-5 py-3.5 mb-6">
          <Info
            size={24}
            strokeWidth={2}
            aria-hidden
            style={{ width: 24, height: 24, flexShrink: 0 }}
            className="text-ochre"
          />
          <p className="text-[12.5px] text-ink-soft leading-relaxed">
            Använd bara{" "}
            <span className="text-ink font-medium">
              öppen och publik information
            </span>{" "}
            i det här flödet. Ladda inte upp personuppgifter, sekretessbelagda
            eller på annat sätt känsliga uppgifter.
          </p>
        </div>

        {speakerMappingSteps.length > 0 && (
          <div className="paper-card px-4 py-3 mb-5 flex items-start gap-3">
            <Users
              className="h-4 w-4 mt-0.5 shrink-0 text-primary"
              strokeWidth={2}
            />
            <p className="text-[12px] text-ink-soft leading-relaxed">
              Flödet pausar efter transkriberingen så att du kan bekräfta vem
              som är vem bland talarna. Namnen skrivs sedan in i transkriptet
              innan resten av flödet körs.
            </p>
          </div>
        )}

        {formFields.length > 0 && (
          <div className="flex flex-col gap-5 mb-6">
            {formFields.map((f) => {
              const k = f.name;
              const value = formValues[k] ?? "";
              const inputTypeAttr =
                f.type === "date"
                  ? "date"
                  : f.type === "number"
                    ? "number"
                    : "text";
              const isLong =
                f.type === "textarea" ||
                f.type === "long_text" ||
                (inputTypeAttr === "text" && value.length > 80);
              return (
                <div key={k} className="w-full space-y-2">
                  <Label htmlFor={k} className="eyebrow-sm">
                    {f.label || f.name}
                    {f.required ? " *" : ""}
                  </Label>
                  {f.description && (
                    <p id={`${k}-description`} className="text-xs text-ink-mute">
                      {f.description}
                    </p>
                  )}
                  {isLong ? (
                    <Textarea
                      id={k}
                      value={value}
                      onChange={(e) => setField(k, e.target.value)}
                      rows={4}
                      required={f.required}
                      aria-describedby={f.description ? `${k}-description` : undefined}
                    />
                  ) : (
                    <Input
                      id={k}
                      type={inputTypeAttr}
                      value={value}
                      onChange={(e) => setField(k, e.target.value)}
                      required={f.required}
                      aria-describedby={f.description ? `${k}-description` : undefined}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {inputType === "audio" && (
          <>
            <section className="mt-4 mb-8 md:mt-6 md:mb-12">
              <AudioRecorder
                acceptedMimetypes={acceptedMimetypes}
                maxBytes={maxFileSizeBytes}
                onChange={onRecorded}
                onRecordingChange={onRecordingChange}
                title={published.name}
                subtitle={inputType.toUpperCase()}
              />
            </section>

            <div
              className="flex items-center gap-3 my-4 md:my-5"
              aria-hidden
            >
              <div className="flex-1 h-px bg-rule-soft" />
              <span className="eyebrow-sm">eller</span>
              <div className="flex-1 h-px bg-rule-soft" />
            </div>

            <label className="paper-card flex items-center gap-3 md:gap-4 px-4 py-3.5 md:px-5 md:py-4 cursor-pointer transition-colors hover:border-ink/40 mb-2">
              <div className="grid place-items-center h-10 w-10 md:h-12 md:w-12 rounded-xl bg-bg-2 text-ink-soft shrink-0">
                <FileAudio className="h-4 w-4 md:h-5 md:w-5" strokeWidth={1.8} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] md:text-[15px] font-medium text-ink leading-tight">
                  Ladda upp ljudfil
                </div>
                <div className="text-[12px] md:text-[13px] text-ink-mute mt-0.5 truncate">
                  {file
                    ? `${file.filename} · ${formatBytes(file.blob.size)}`
                    : (acceptedMimetypes.length
                        ? acceptedMimetypes
                            .map((m) =>
                              m
                                .replace(/^audio\//, "")
                                .replace(/^video\//, "")
                                .replace(/^x-/, "")
                                .toUpperCase(),
                            )
                            .filter((v, i, a) => a.indexOf(v) === i)
                            .slice(0, 6)
                            .join(" · ")
                        : "MP3 · WAV · M4A · OGG")}
                </div>
              </div>
              <Upload
                className="h-4 w-4 md:h-5 md:w-5 text-ink-mute shrink-0"
                strokeWidth={1.8}
              />
              <input
                type="file"
                accept={acceptedMimetypes.join(",") || "audio/*"}
                onChange={onFilePicked}
                className="sr-only"
              />
            </label>
            {file && localFileUrl && (
              <div className="flex items-center justify-between gap-3 mb-2 px-1">
                <p className="text-[12px] text-ink-mute">
                  Spara gärna en kopia innan du startar. Om sidan stängs innan
                  uppladdningen är klar kan inspelningen gå förlorad.
                </p>
                <a
                  href={localFileUrl}
                  download={file.filename}
                  className="shrink-0 text-[12px] font-medium text-ink underline underline-offset-4"
                >
                  Spara kopia
                </a>
              </div>
            )}
          </>
        )}

        {inputType !== "audio" && acceptsUpload && (
          <section className="paper-card p-5 md:p-6 mb-3 space-y-3">
            <div className="eyebrow-sm">Fil</div>
            <input
              type="file"
              accept={acceptedMimetypes.join(",") || undefined}
              onChange={onFilePicked}
              className="text-sm text-ink-soft"
            />
            {file && (
              <p className="text-[13px] text-ink-soft">
                Vald: <span className="text-ink">{file.filename}</span> (
                {formatBytes(file.blob.size)})
              </p>
            )}
            {maxFileSizeBytes && (
              <p className="text-xs text-ink-mute">
                Max storlek: {formatBytes(maxFileSizeBytes)}
              </p>
            )}
          </section>
        )}

        {runError && (
          <div
            className="bg-primary text-primary-foreground rounded-2xl px-4 py-3.5 md:px-5 md:py-4 mt-4 flex items-start gap-3"
            role="alert"
          >
            <AlertCircle
              className="h-5 w-5 md:h-6 md:w-6 shrink-0 mt-0.5"
              strokeWidth={2}
            />
            <div className="flex-1 min-w-0">
              <div className="font-mono text-[9px] md:text-[10px] tracking-[0.16em] uppercase text-primary-foreground/80 mb-1">
                Fel
              </div>
              <p className="text-[14px] md:text-[15px] font-medium leading-snug break-words">
                {runError}
              </p>
            </div>
          </div>
        )}

        <div className="pt-5 md:pt-6 flex justify-center">
          <Button
            type="button"
            onClick={onRun}
            disabled={!canSubmit || submitting}
            className="text-[14px]"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {submitting ? "Startar…" : "Kör flöde"}
          </Button>
        </div>

        <EarlierRuns runs={earlierRuns} onOpen={onOpenRun} className="pt-10" />
      </div>
    </>
  );
}

// ---------- Recording (post-submit, pre-result) ----------

function RecordingView({
  published,
  submission,
  onCancelSubmission,
}: {
  published: FlowPublished;
  submission: SubmissionState;
  onCancelSubmission: () => void;
}) {
  const isUploading = submission.kind === "uploading";
  return (
    <>
      <div className="px-5 md:px-8 pt-4 md:pt-6">
        <OfflineBanner waiting={submission.kind === "idle" ? "run" : "upload"} />
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

// ---------- Helpers ----------

/** Formulärvärdena som körningens input_payload_json; tomma fält skickas inte. */
function formPayload(
  fields: FormField[],
  values: Record<string, string>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.name];
    if (v != null && v !== "") payload[f.name] = v;
  }
  return payload;
}
