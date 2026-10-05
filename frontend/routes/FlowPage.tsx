"use client";


import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useNavigate, useParams } from "react-router";
import { AuthGate, useAuthenticatedUser } from "@/components/AuthGate";
import { createDocument } from "@/components/flow/DetailsForm";
import { FlowInput } from "@/components/flow/FlowInput";
import { FlowSkeleton, FlowUnavailable } from "@/components/flow/FlowPageStates";
import { FlowFrame } from "@/components/flow/FlowFrame";
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
import { RECORDING_QUERY_PARAM } from "@/lib/flow-address";
import type { SubmitRequest } from "@/lib/flow-session";
import { makesText } from "@/lib/flow-output";
import { followRun, readFinishedRun, VISIBLE_POLL_MS } from "@/lib/follow-run";
import { onlineStatus } from "@/lib/online-status";
import { recordingStore } from "@/lib/recording-store";
import { leaveWarning, UNSTORED_LEAVE } from "@/lib/recording-view";
import { resultFileViews } from "@/lib/run-files";
import {
  finishedRun,
  ofContractVersion,
  runOutcome,
  runStage,
  runSteps,
  runLabelsSpeakers,
} from "@/lib/run-progress";
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
import { useRouteReady } from "@/routes/RouteEffects";

export default function FlowDetailPage() {
  const { id } = useParams() as { id: string };
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
  | { kind: "running"; run: Pick<FlowRunSummary, "id" | "status" | "flow_version" | "created_at">; graph: FlowGraph | null }
  | {
      kind: "awaiting_review";
      run: FlowRunPublic;
      steps: FlowRunStep[];
      checkpoint: FlowRunReviewCheckpointPublic;
    }
  | { kind: "done"; run: FlowRunPublic; steps: FlowRunStep[]; graph: FlowGraph | null };

// The run's id is kept in the address (?run=), so a reload or a shared link resumes the same run.
const RUN_QUERY_PARAM = "run";

function readRunIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get(RUN_QUERY_PARAM);
}

function FlowDetail({ flowId }: { flowId: string }) {
  const navigate = useNavigate();
  // The page's own state in the address: written through the router, which keeps the entry (replace), so it is no
  // departure and Back goes where it went before. The router has written it when this returns, so a read of
  // window.location.search sees it.
  const writeSearch = (change: (search: URLSearchParams) => void) => {
    const search = new URLSearchParams(window.location.search);
    change(search);
    void navigate({ search: search.toString() }, { replace: true });
  };
  const writeRunIdToUrl = (runId: string | null) =>
    writeSearch((search) => (runId ? search.set(RUN_QUERY_PARAM, runId) : search.delete(RUN_QUERY_PARAM)));
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
  // The details a run was started with, shown beside its states, and its own speaker-label choice for its progress
  // line: as the run Eneo returned carries them, or read once for a run opened while it runs (its polled status does
  // not carry them).
  const [startedWith, setStartedWith] = useState<{ runId: string | null; input: unknown; speakerLabels?: boolean | null }>({
    runId: null,
    input: null,
  });
  const runningRun = run.kind === "running" ? run.run : null;
  useEffect(() => {
    if (!runningRun || startedWith.runId === runningRun.id) return;
    if ("input_payload_json" in runningRun) {
      const full = runningRun as FlowRunPublic;
      setStartedWith({ runId: full.id, input: full.input_payload_json ?? null, speakerLabels: full.speaker_labels });
      return;
    }
    let current = true;
    getRun(flowId, runningRun.id)
      .then(
        (full) =>
          current && setStartedWith({ runId: full.id, input: full.input_payload_json ?? null, speakerLabels: full.speaker_labels }),
      )
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

  // Opened by "Skapa dokument" on an unsent recording in the flow list: the recording is sent once the flow has loaded.
  useEffect(() => {
    if (!contract) return;
    const recordingId = new URLSearchParams(window.location.search).get(RECORDING_QUERY_PARAM);
    if (!recordingId) return;
    writeSearch((search) => search.delete(RECORDING_QUERY_PARAM));
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
  async function sendInput({ input: runInput, payload, speakerLabels, maxSpeakers }: SubmitRequest) {
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
        maxSpeakers,
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
      setStartedWith({
        runId: initialRun.id,
        input: initialRun.input_payload_json ?? payload,
        speakerLabels: initialRun.speaker_labels,
      });
      setRun({ kind: "running", run: initialRun, graph: null });
      void follow(initialRun.id);
    } catch (err) {
      setRun({ kind: "idle" });
      setSubmission({ kind: "idle" });
      submitAbortRef.current = null;
      throw err;
    }
  }

  /** The person's latest runs of the flow, the first page of them; the list is a shortcut and may be missing. */
  function loadEarlierRuns() {
    void earlier.reload();
  }

  /** Takes up an existing run (from the address or the list) and follows it. */
  function resumeRun(runId: string) {
    setRunError(null);
    setRetryRefusal(null);
    writeRunIdToUrl(runId);
    setRun({ kind: "opening" });
    void follow(runId);
  }

  /**
   * Follows the run by its status and its run-locked graph until it is done or waits for review. The step results (an
   * audit-logged read) and the detail are read once, when the run is done.
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
        // Eneo answers null while the pause is not visible yet; an error is not that, and ends the following below.
        const checkpoint = await getActiveReviewCheckpoint(flowId, runId);
        if (signal.aborted) return;
        if (checkpoint) {
          // Paused until the person has acted; the review view starts the following again.
          setRun({ kind: "awaiting_review", run: last.run as FlowRunPublic, steps: [], checkpoint });
        } else {
          // The checkpoint shows a moment after the status does: read again shortly.
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
    // The cancelled run is read now, not at the next poll.
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
          // The step's output itself (a text or a JSON value), not the payload envelope.
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
      // After e.g. a stale revision: the current checkpoint is read, so that the form follows the server's version
      // before the person tries again.
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

  async function onReject(checkpoint: FlowRunReviewCheckpointPublic, runId: string, reason: string) {
    setRunError(null);
    try {
      await rejectReviewCheckpoint(flowId, runId, checkpoint.id, {
        expected_checkpoint_revision: checkpoint.revision,
        reason,
      });
      // The run is cancelled: followed to its end, so that its steps and result are read as usual.
      void follow(runId);
    } catch (err) {
      setRunError(friendlyError(err));
    }
  }

  /** A new recording: the same flow and details (the participants); the session let go of the audio when it was sent. */
  function onRunAgain() {
    followAbortRef.current?.abort();
    setRunError(null);
    setRetryRefusal(null);
    writeRunIdToUrl(null);
    setRun({ kind: "idle" });
    loadEarlierRuns();
  }

  /** "Försök igen": Eneo continues the failed run from its first unfinished step in a new run; what was finished is not done again. */
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

  /** A new run with the same audio and details: after a cancellation, or when Eneo cannot continue. */
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

  useRouteReady(loadError !== null || (published !== null && contract !== null));
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
        onOpenRun={resumeRun}
        onMoreRuns={() => void earlier.more()}
        unsentRecordings={unsentRecordings}
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
      flowPage(
        <SubmittingView
          submission={submission}
          onCancelSubmission={onCancelSubmission}
          makesText={makesText(contract.final_output)}
        />,
        {
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
      // The review's own heading names the state, so the flow's name is not the heading.
      <FlowFrame title={published.name} titleIsHeading={false}>
        <ReviewView
          flowId={flowId}
          published={published}
          checkpoint={run.checkpoint}
          runState={{ run: run.run, steps: run.steps }}
          runError={runError}
          onContinue={(cp, edit, options) => onContinue(cp, run.run.id, edit, options)}
          onSaveEdit={onSaveEdit}
          onReject={(cp, reason) => onReject(cp, run.run.id, reason)}
        />
      </FlowFrame>,
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
        stage={runStage(
          steps,
          run.run.status,
          startedWith.runId === run.run.id &&
            runLabelsSpeakers(startedWith.speakerLabels, contract.transcription?.speaker_labels, ofContractVersion(run.run, contract)),
        )}
        startedAt={run.run.created_at}
        error={runError}
        // Today's contract speaks only for a run of its own version.
        makesText={ofContractVersion(run.run, contract) && makesText(contract.final_output)}
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
      // The result has its own layout; its heading names the state, so the flow's name is not the heading.
      <FlowFrame title={published.name} titleIsHeading={false}>
        <RunResult
          flowId={flowId}
          flowName={published.name}
          run={run.run}
          steps={steps}
          stepResults={run.steps}
          files={files}
          showTranscript={transcribed}
          contract={contract}
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
      </FlowFrame>
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
      contract={contract}
      error={runError}
      refusal={retryRefusal}
      onRetry={sameInputHelps && !cancelled ? () => onRetry(run) : undefined}
      onStartAgain={startAgainOffered ? () => onStartAgain(run) : undefined}
      onChooseInput={onRunAgain}
    />,
    { input: run.run.input_payload_json, version: run.run.flow_version },
  );
}
