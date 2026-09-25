"use client";


import {
  use,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AuthGate, useAuthenticatedUser } from "@/components/AuthGate";
import { createDocument } from "@/components/flow/DetailsForm";
import { FlowInput } from "@/components/flow/FlowInput";
import { FlowSkeleton, FlowUnavailable } from "@/components/flow/FlowPageStates";
import { FlowTopBar } from "@/components/flow/FlowTopBar";
import { RunFailure } from "@/components/flow/RunFailure";
import { RunOpening, RunProgress, RunUnread } from "@/components/flow/RunProgress";
import { RunResult } from "@/components/flow/RunResult";
import { FlowRunPage } from "@/components/flow/FlowRunPage";
import type { OfflineWaiting } from "@/components/OfflineBanner";
import { SubmittingView, type SubmissionState } from "@/components/flow/SubmittingView";
import { ReviewView } from "@/components/flow/ReviewView";
import { continueFromPause } from "@/lib/review-continue";
import { useFlowSession } from "@/components/flow/useFlowSession";
import { LeaveContext, useLeaveQuestion } from "@/components/flow/useLeaveQuestion";
import { useUnsentRecordings } from "@/components/UnsentRecordings";
import {
  cancelRun,
  editReviewCheckpoint,
  getActiveReviewCheckpoint,
  getPublishedFlow,
  getRun,
  getRunContract,
  rejectReviewCheckpoint,
  type FlowGraph,
  type FlowPublished,
  type FlowRunPublic,
  type FlowRunReviewCheckpointPublic,
  type FlowRunStep,
  type FlowRunSummary,
  type ReviewEditedValue,
  type RunContract,
} from "@/lib/api";
import { unstoredDrafts } from "@/lib/drafts";
import { EarlierRunsList } from "@/lib/earlier-runs";
import { friendlyError } from "@/lib/errors";
import type { SubmitRequest } from "@/lib/flow-session";
import { followRun, readFinishedRun, VISIBLE_POLL_MS } from "@/lib/follow-run";
import { onlineStatus } from "@/lib/online-status";
import { followRunAddress } from "@/lib/leave-guard";
import { recordingStore } from "@/lib/recording-store";
import { leaveWarning, UNSTORED_LEAVE } from "@/lib/recording-view";
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
import { selectRuntimeInputStep } from "@/lib/upload";

/** A review's unsaved edit: the text, or the speakers' names. */
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
  | { kind: "opening"; runId: string }
  // The run has ended, but its result or steps could not be read.
  | { kind: "unread"; runId: string; message: string }
  | { kind: "running"; run: Pick<FlowRunSummary, "id" | "status" | "flow_version" | "created_at">; graph: FlowGraph | null }
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

/** `push`: a history entry of its own, so browser Back returns to the flow page (a run opened from the list). */
function writeRunIdToUrl(runId: string | null, push = false) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (runId) url.searchParams.set(RUN_QUERY_PARAM, runId);
  else url.searchParams.delete(RUN_QUERY_PARAM);
  window.history[push ? "pushState" : "replaceState"](window.history.state, "", url);
}

function FlowDetail({ flowId }: { flowId: string }) {
  const [published, setPublished] = useState<FlowPublished | null>(null);
  const [contract, setContract] = useState<RunContract | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const [run, setRun] = useState<RunState>({ kind: "idle" });
  // A run's view has been shown here: the setup that takes its place announces itself, unlike on first load.
  const [shownRun, setShownRun] = useState(false);
  if (run.kind !== "idle" && !shownRun) setShownRun(true);
  const [submission, setSubmission] = useState<SubmissionState>({
    kind: "idle",
  });
  // The details a run was started with, shown beside its states: as sent, as the run Eneo returned carries
  // them, or read once for a run opened while it runs (its polled status does not carry them).
  const [startedWith, setStartedWith] = useState<{ runId: string | null; input: unknown }>({ runId: null, input: null });
  const runningRun = run.kind === "running" ? run.run : null;
  useEffect(() => {
    if (!runningRun || startedWith.runId === runningRun.id) return;
    if ("input_payload_json" in runningRun) {
      setStartedWith({ runId: runningRun.id, input: (runningRun as FlowRunPublic).input_payload_json ?? null });
      return;
    }
    let current = true;
    getRun(flowId, runningRun.id)
      .then((full) => current && setStartedWith({ runId: full.id, input: full.input_payload_json ?? null }))
      .catch(() => undefined);
    return () => {
      current = false;
    };
    // Once per run shown running: the status reads that replace it later carry no details.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningRun?.id]);
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
      // Left: what the browser could not keep is gone with the page.
      unstoredDrafts.forget();
    };
  }, []);

  // Leaving asks first while audio is being recorded or waits to become a document (until Eneo has the run: an
  // upload, and its start, which may retry or wait for a new login), or typed work the browser could not keep.
  const holdsAudio = snapshot.phase !== "setup";
  const submitting = run.kind === "submitting";
  const unstored = useSyncExternalStore(unstoredDrafts.subscribe, unstoredDrafts.any, () => false);
  const leaving = useLeaveQuestion(
    submitting || holdsAudio || unstored,
    submitting || holdsAudio ? leaveWarning(input.persistent, snapshot.phase, submitting) : UNSTORED_LEAVE,
  );
  useEffect(() => {
    const shouldWarn = holdsAudio || submitting || unstored;
    if (!shouldWarn) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [holdsAudio, submitting, unstored]);

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
    setStartedWith({ runId: null, input: payload });
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
      setStartedWith({ runId: initialRun.id, input: initialRun.input_payload_json ?? payload });
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
  function resumeRun(runId: string, push = false) {
    setRunError(null);
    setRetryRefusal(null);
    writeRunIdToUrl(runId, push);
    setRun({ kind: "opening", runId });
    void follow(runId);
  }

  // Browser Back and Forward between the flow page and a run opened from its list show what the address names.
  const addressRun = useRef<string | null>(null);
  addressRun.current =
    run.kind === "idle" || run.kind === "submitting" ? null : run.kind === "opening" || run.kind === "unread" ? run.runId : run.run.id;
  useEffect(
    () => followRunAddress(window, () => addressRun.current, (runId) => (runId ? resumeRun(runId) : onRunAgain())),
    // Once: the page's own handlers keep no state of their own between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

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

  /**
   * Saves the pause's edit, approves and resumes (continueFromPause); returns why the flow did not go on, or null,
   * also shown on the page. The pause's newer states reach the view, so trying again starts from them.
   */
  async function onContinue(
    checkpoint: FlowRunReviewCheckpointPublic,
    runId: string,
    edit: ReviewEditedValue | null,
    { describe = friendlyError, onSaved }: { describe?: (err: unknown) => string; onSaved?: () => void } = {},
  ): Promise<string | null> {
    setRunError(null);
    const hold = (cp: FlowRunReviewCheckpointPublic) =>
      setRun((prev) => (prev.kind === "awaiting_review" ? { ...prev, checkpoint: cp } : prev));
    try {
      const resumedRun = await continueFromPause({ flowId, runId, checkpoint, edit, onCheckpoint: hold, onHeld: onSaved });
      // Följ körningen igen — den är nu i "running".
      setRun({ kind: "running", run: resumedRun, graph: null });
      void follow(resumedRun.id);
      return null;
    } catch (err) {
      const message = describe(err);
      setRunError(message);
      // The pause as Eneo has it now (a newer revision, or approved), so trying again starts from it.
      const latest = await getActiveReviewCheckpoint(flowId, runId).catch(() => null);
      if (latest?.id === checkpoint.id) hold(latest);
      return message;
    }
  }

  async function onSaveEdit(
    checkpoint: FlowRunReviewCheckpointPublic,
    editedValue: ReviewEditedValue,
    describe: (err: unknown) => string = friendlyError,
  ): Promise<FlowRunReviewCheckpointPublic | { error: string }> {
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
      const message = describe(err);
      setRunError(message);
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
      return { error: message };
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
    setStartedWith({ runId: null, input: failed.run.input_payload_json ?? null });
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

  // The views that can hold unsent work: the leave question, and their top bar's exits through it.
  const withLeave = (view: ReactNode) => (
    <LeaveContext.Provider value={leaving}>
      {view}
      {leaving.question}
    </LeaveContext.Provider>
  );

  if (run.kind === "idle") {
    return withLeave(
      <FlowInput
        published={published}
        contract={contract}
        input={input}
        ownerId={user.id}
        notice={runError}
        earlierRuns={earlierRuns}
        onOpenRun={(runId) => resumeRun(runId, true)}
        onMoreRuns={() => void earlier.more()}
        unsentRecordings={unsentRecordings}
        onLeave={leaving.onLeave}
        afterRun={shownRun}
      />,
    );
  }

  // A run's states keep the flow's page, with the details it was started with; only the state's card changes.
  const flowPage = (
    view: ReactNode,
    {
      input = null,
      version = null,
      locked = false,
      offline = null,
    }: { input?: unknown; version?: number | null; locked?: boolean; offline?: OfflineWaiting } = {},
  ) => (
    <FlowRunPage published={published} contract={contract} input={input} version={version} locked={locked} offline={offline}>
      {view}
    </FlowRunPage>
  );

  if (run.kind === "submitting") {
    return withLeave(
      flowPage(<SubmittingView submission={submission} onCancelSubmission={onCancelSubmission} />, {
        input: startedWith.input,
        // Sent just now, from this contract's form.
        version: contract.published_flow_version,
        locked: true,
        offline: submission.kind === "idle" ? "run" : "upload",
      }),
    );
  }

  if (run.kind === "awaiting_review") {
    return withLeave(
      <ReviewView
        flowId={flowId}
        published={published}
        checkpoint={run.checkpoint}
        runState={{ run: run.run, steps: run.steps }}
        runError={runError}
        onContinue={(cp, edit, options) => onContinue(cp, run.run.id, edit, options)}
        onSaveEdit={onSaveEdit}
        onReject={(cp, reason) =>
          onReject(cp, { run: run.run, steps: run.steps }, reason)
        }
      />,
    );
  }

  if (run.kind === "opening") return flowPage(<RunOpening />);

  if (run.kind === "unread") return flowPage(<RunUnread message={run.message} onRetry={() => resumeRun(run.runId)} />);

  if (run.kind === "running") {
    const steps = runSteps(run.graph, run.run, [], contract);
    return flowPage(
      <RunProgress
        flowName={published.name}
        steps={steps}
        stage={runStage(steps, run.run.status)}
        startedAt={run.run.created_at}
        error={runError}
        onCancel={() => onCancelRun(run.run.id)}
      />,
      { input: startedWith.runId === run.run.id ? startedWith.input : null, version: run.run.flow_version, offline: "run" },
    );
  }

  const { steps, transcribed, stepLabels } = finishedRun(run.graph, run.run, run.steps);
  const files = resultFileViews(run.run.result_files ?? []);
  const inputStep = selectRuntimeInputStep(contract);
  if (runOutcome(run.run.status) === "succeeded") {
    return (
      <>
        {/* The result has its own layout; its heading names the state, so the flow's name is not the heading. */}
        <FlowTopBar title={published.name} titleIsHeading={false} />
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
          onRegenerated={(regenerated) => {
            // The new run is followed like any other, from its progress to its own result.
            setRunError(null);
            writeRunIdToUrl(regenerated.id);
            setRun({ kind: "running", run: regenerated, graph: null });
            void follow(regenerated.id);
          }}
        />
      </>
    );
  }
  const failure = run.run.error ? runErrorView(run.run.error, stepLabels) : null;
  // The same audio cannot help when the input itself has to change.
  const sameInputHelps = !failure?.inputMustChange;
  const cancelled = runOutcome(run.run.status) === "cancelled";
  const startAgainOffered = sameInputHelps && startAgainRequest(run.run, run.steps, contract) !== null;
  return flowPage(
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
      onChooseInput={onRunAgain}
    />,
    { input: run.run.input_payload_json, version: run.run.flow_version },
  );
}
