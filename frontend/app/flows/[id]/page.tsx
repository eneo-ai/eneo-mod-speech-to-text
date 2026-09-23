"use client";

import { useTranscriptCorrections } from "@/components/useTranscriptCorrections";

import Link from "next/link";
import { CheckCircle2, Loader2 } from "lucide-react";
import { SPEAKER_REVIEW_ENABLED } from "@/lib/speaker-review";
import { use, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AuthGate, useAuthenticatedUser } from "@/components/AuthGate";
import { createDocument } from "@/components/flow/DetailsForm";
import { FlowInput } from "@/components/flow/FlowInput";
import { FlowSkeleton, FlowUnavailable } from "@/components/flow/FlowPageStates";
import { FlowTopBar } from "@/components/flow/FlowTopBar";
import { FRAME, FRAME_WIDTH, ReadingMain } from "@/components/frame";
import { RunFailure } from "@/components/flow/RunFailure";
import { RunOpening, RunProgress, RunUnread } from "@/components/flow/RunProgress";
import { RunResult } from "@/components/flow/RunResult";
import { SubmittingView, type SubmissionState } from "@/components/flow/SubmittingView";
import { useFlowSession } from "@/components/flow/useFlowSession";
import { useUnsentRecordings } from "@/components/UnsentRecordings";
import {
  approveReviewCheckpoint,
  cancelRun,
  editReviewCheckpoint,
  getActiveReviewCheckpoint,
  getPublishedFlow,
  getRun,
  getRunContract,
  inputFileAudioUrl,
  isReviewCheckpointApproved,
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
import { EarlierRunsList } from "@/lib/earlier-runs";
import { friendlyError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import type { SubmitRequest } from "@/lib/flow-session";
import { followRun, readFinishedRun, VISIBLE_POLL_MS } from "@/lib/follow-run";
import { onlineStatus } from "@/lib/online-status";
import { recordingStore } from "@/lib/recording-store";
import { resultFileViews } from "@/lib/run-files";
import { finishedRun, runOutcome, runStage, runSteps } from "@/lib/run-progress";
import { runErrorView } from "@/lib/run-result";
import {
  retryFailedRun,
  startAgain,
  startAgainRequest,
  submitRecording,
  submitRun,
  type RetryWait,
  type SubmitProgress,
} from "@/lib/submit-run";
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
import { selectRuntimeInputStep } from "@/lib/upload";

interface PageProps {
  // App Router levererar params som en Promise och packar upp dem med React.use().
  params: Promise<{ id: string }>;
}

export default function FlowDetailPage({ params }: PageProps) {
  const { id } = use(params);
  return (
    <AuthGate>
      {/* One page per flow: its session and its earlier runs belong to that flow. */}
      <FlowDetail key={id} flowId={id} />
    </AuthGate>
  );
}

type RunState =
  | { kind: "idle" }
  | { kind: "submitting" }
  // An earlier run is being read; its state is not known yet.
  | { kind: "opening" }
  // The run has ended, but its result or steps could not be read.
  | { kind: "unread"; runId: string; message: string }
  | { kind: "running"; run: Pick<FlowRunSummary, "id" | "status">; graph: FlowGraph | null }
  | {
      kind: "awaiting_review";
      run: FlowRunPublic;
      steps: FlowRunStep[];
      checkpoint: FlowRunReviewCheckpointPublic;
    }
  | { kind: "done"; run: FlowRunPublic; steps: FlowRunStep[]; graph: FlowGraph | null };

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
  const [loadError, setLoadError] = useState<unknown>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const [run, setRun] = useState<RunState>({ kind: "idle" });
  const [submission, setSubmission] = useState<SubmissionState>({
    kind: "idle",
  });
  // This user's earlier runs of the flow, a page at a time.
  const [earlier] = useState(() => new EarlierRunsList(flowId));
  const earlierRuns = useSyncExternalStore(earlier.subscribe, earlier.getSnapshot, earlier.getSnapshot);
  // Why Eneo would not continue the failed run on screen, and whether a new run is the way on.
  const [retryRefusal, setRetryRefusal] = useState<{ message: string; startAgain: boolean } | null>(null);

  const followAbortRef = useRef<AbortController | null>(null);
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
    Promise.all([getPublishedFlow(flowId), getRunContract(flowId)])
      .then(([p, c]) => {
        if (cancelled) return;
        setPublished(p);
        setContract(c);

        // Återuppta körningen i URL:en (t.ex. efter omladdning mitt i en
        // granskning). Annars: visa flödets senaste körningar.
        const urlRunId = readRunIdFromUrl();
        if (urlRunId) resumeRun(urlRunId);
        else loadEarlierRuns();
      })
      .catch((err) => !cancelled && setLoadError(err));
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
  useEffect(() => session.setHandlers({ submit: sendInput, reloadFlow, refreshEarlierRuns: loadEarlierRuns }));

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
      setRun({ kind: "running", run: initialRun, graph: null });
      void follow(initialRun.id);
    } catch (err) {
      setRun({ kind: "idle" });
      setSubmission({ kind: "idle" });
      submitAbortRef.current = null;
      throw err;
    }
  }

  /** Användarens senaste körningar av flödet, från första sidan; listan är en genväg och får saknas. */
  function loadEarlierRuns() {
    void earlier.reload();
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
      let finished: Awaited<ReturnType<typeof readFinishedRun>>;
      try {
        finished = await readFinishedRun(flowId, last.run);
      } catch (err) {
        if (!signal.aborted) setRun({ kind: "unread", runId, message: friendlyError(err) });
        return;
      }
      if (signal.aborted) return;
      setRun({ kind: "done", run: finished.run, steps: finished.steps, graph: last.graph });
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

  /** Ny inspelning: samma flöde och uppgifter (deltagarna); sessionen släppte ljudet när det skickades. */
  function onRunAgain() {
    followAbortRef.current?.abort();
    setRunError(null);
    setRetryRefusal(null);
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
    const abortController = new AbortController();
    submitAbortRef.current = abortController;
    const outcome = await retryFailedRun(flowId, failed.run.id);
    // The page went away while Eneo answered: nothing is shown or followed from here.
    if (abortController.signal.aborted) return;
    submitAbortRef.current = null;
    if (outcome.kind === "refused") {
      setRetryRefusal({ message: outcome.message, startAgain: outcome.startAgain });
      return;
    }
    writeRunIdToUrl(outcome.run.id);
    setRun({ kind: "running", run: outcome.run, graph: null });
    void follow(outcome.run.id);
  }

  /** En ny körning med samma ljud och uppgifter: efter en avbrytning, eller när Eneo inte kan fortsätta. */
  async function onStartAgain(failed: Extract<RunState, { kind: "done" }>) {
    setRunError(null);
    setRun({ kind: "submitting" });
    setSubmission({ kind: "starting", wait: null });
    // "Avbryt" and leaving the page end it: nothing more is sent, shown or followed.
    const abortController = new AbortController();
    submitAbortRef.current = abortController;
    try {
      const outcome = await startAgain(flowId, failed.run, failed.steps, {
        online: onlineStatus,
        signal: abortController.signal,
        onWait: (wait) => setSubmission({ kind: "starting", wait }),
      });
      submitAbortRef.current = null;
      setSubmission({ kind: "idle" });
      // Avbryt goes back to the failed run; after the page left, no URL change and no following.
      if (!outcome) {
        setRun(failed);
        return;
      }
      // The flow as it is published now.
      setContract(outcome.contract);
      if (outcome.kind === "review") {
        // Back to the details and a new recording or file, against the flow as it is now.
        setRetryRefusal(null);
        writeRunIdToUrl(null);
        setRunError(outcome.message);
        setRun({ kind: "idle" });
        loadEarlierRuns();
        return;
      }
      // A refusal that led here stays on the failure view until a new run exists.
      setRetryRefusal(null);
      writeRunIdToUrl(outcome.run.id);
      setRun({ kind: "running", run: outcome.run, graph: null });
      void follow(outcome.run.id);
    } catch (err) {
      submitAbortRef.current = null;
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

  if (loadError) return <FlowUnavailable error={loadError} />;
  if (!published || !contract) return <FlowSkeleton />;

  if (run.kind === "idle") {
    return (
      <FlowInput
        published={published}
        contract={contract}
        input={input}
        ownerId={user.id}
        notice={runError}
        earlierRuns={earlierRuns}
        onOpenRun={resumeRun}
        onMoreRuns={() => void earlier.more()}
        unsentRecordings={unsentRecordings}
      />
    );
  }

  if (run.kind === "submitting") {
    return (
      <SubmittingView
        published={published}
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

  // A run's own views: the view's heading names the state, so the flow's name is not the heading.
  const topBar = <FlowTopBar title={published.name} titleIsHeading={false} />;

  if (run.kind === "opening") {
    return (
      <>
        {topBar}
        <RunOpening />
      </>
    );
  }

  if (run.kind === "unread") {
    return (
      <>
        {topBar}
        <RunUnread message={run.message} onRetry={() => resumeRun(run.runId)} />
      </>
    );
  }

  if (run.kind === "running") {
    const steps = runSteps(run.graph, run.run);
    return (
      <>
        {topBar}
        <RunProgress
          steps={steps}
          stage={runStage(steps, run.run.status)}
          error={runError}
          onCancel={() => onCancelRun(run.run.id)}
        />
      </>
    );
  }

  const { steps, transcribed, stepLabels } = finishedRun(run.graph, run.run, run.steps);
  const files = resultFileViews(run.run.result_files ?? []);
  const inputStep = selectRuntimeInputStep(contract);
  if (runOutcome(run.run.status) === "succeeded") {
    return (
      <>
        {topBar}
        {/* The result's views bring their own gutters; the frame gives them its width. */}
        <div className={cn(FRAME_WIDTH, "flex flex-1 flex-col")}>
          <RunResult
            flowId={flowId}
            flowName={published.name}
            run={run.run}
            steps={steps}
            stepResults={run.steps}
            files={files}
            showTranscript={transcribed}
            audio={inputStep?.input_format?.toLowerCase() === "audio"}
            onNewRecording={onRunAgain}
          />
        </div>
      </>
    );
  }
  const failure = run.run.error ? runErrorView(run.run.error, stepLabels) : null;
  // The same audio cannot help when the input itself has to change.
  const sameInputHelps = !failure?.inputMustChange;
  const cancelled = runOutcome(run.run.status) === "cancelled";
  const startAgainOffered = sameInputHelps && startAgainRequest(run.run, run.steps, contract) !== null;
  return (
    <>
      {topBar}
      <div className={cn(FRAME_WIDTH, "flex flex-1 flex-col")}>
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
          onStartAgain={startAgainOffered ? () => onStartAgain(run) : undefined}
        />
      </div>
    </>
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
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setShowReject(false);
            setRejectReason("");
          }}
          disabled={working === "reject"}
        >
          Avbryt
        </Button>
        <Button type="button" onClick={submitReject} disabled={!rejectReason.trim() || working === "reject"}>
          {working === "reject" ? <Loader2 data-icon="inline-start" aria-hidden className="animate-spin" /> : null}
          Bekräfta avvisning
        </Button>
      </div>
    </section>
  ) : null;

  const actions = (
    <div className="mt-auto flex items-center justify-between gap-3 pt-4">
      <Button type="button" variant="ghost" onClick={() => setShowReject(true)} disabled={working !== null || showReject}>
        Avvisa
      </Button>
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

  const header = <FlowTopBar title={published.name} titleIsHeading={false} />;
  const paused = <p className="mb-2 text-[13px] text-ink-mute">Pausat i steg {checkpoint.step_order}</p>;

  if (isSpeakerMapping) {
    return (
      <>
        {header}
        <main className={cn(FRAME, "flex flex-1 flex-col pb-6 pt-2 lg:pt-8")}>
          {paused}
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
              className="paper-card lg:min-h-[28rem] lg:max-h-[calc(100vh-14rem)] lg:overflow-hidden"
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
      <ReadingMain>
        {paused}
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
      </ReadingMain>
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
