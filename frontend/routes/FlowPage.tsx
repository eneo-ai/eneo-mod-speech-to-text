
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useLocation, useNavigate, useNavigationType, useParams } from "react-router";
import { AuthGate, useAuthenticatedUser } from "@/components/AuthGate";
import { createDocument } from "@/components/flow/DetailsForm";
import { FlowInput } from "@/components/flow/FlowInput";
import { FlowSkeleton, FlowUnavailable } from "@/components/flow/FlowPageStates";
import { FlowFrame } from "@/components/flow/FlowFrame";
import { preloadMarkdown } from "@/components/flow/Markdown";
import { RunOpening, RunProgress, RunUnread } from "@/components/flow/RunProgress";
import { preloadRunViews, WithRunViews } from "@/components/flow/run-views";
import { FlowRunPage } from "@/components/flow/FlowRunPage";
import type { OfflineWaiting } from "@/components/OfflineBanner";
import { SubmittingView, type SubmissionState } from "@/components/flow/SubmittingView";
import { continueFromPause } from "@/lib/review-continue";
import { useFlowSession } from "@/components/flow/useFlowSession";
import { LeaveContext, useLeaveQuestion } from "@/components/flow/useLeaveQuestion";
import { useUnsentRecordings } from "@/components/UnsentRecordings";
import {
  cancelRun,
  editReviewCheckpoint,
  ApiError,
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
import { friendlyError, reviewPauseEnded } from "@/lib/errors";
import { CONTINUE_QUERY_PARAM, RECORDING_QUERY_PARAM } from "@/lib/flow-address";
import type { SubmitRequest } from "@/lib/flow-session";
import { makesText } from "@/lib/flow-output";
import { followRun, readActivePause, readFinishedRun, VISIBLE_POLL_MS, type SavedCorrections } from "@/lib/follow-run";
import { onlineStatus } from "@/lib/online-status";
import { filesIn, recordingStore } from "@/lib/recording-store";
import { asksBeforeClosing, leaveKeepsWork, leaveWarning, UNSTORED_LEAVE } from "@/lib/recording-view";
import { resultFileViews } from "@/lib/run-files";
import {
  finishedRun,
  finishesUnattended,
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
  | { kind: "opening"; runId: string }
  // The run has ended, or waits for review (`review`), but its result, steps or pause could not be read.
  | { kind: "unread"; runId: string; message: string; review?: boolean }
  | { kind: "running"; run: Pick<FlowRunSummary, "id" | "status" | "flow_version" | "created_at">; graph: FlowGraph | null }
  | {
      kind: "awaiting_review";
      run: FlowRunPublic;
      steps: FlowRunStep[];
      checkpoint: FlowRunReviewCheckpointPublic;
      /** The saved transcript corrections, as read with the pause (readActivePause). */
      corrections: SavedCorrections;
    }
  | {
      kind: "done";
      run: FlowRunPublic;
      steps: FlowRunStep[];
      graph: FlowGraph | null;
      /** The saved transcript corrections, as read with the run (readFinishedRun). */
      corrections: SavedCorrections;
    };

// The run's id is kept in the address (?run=), so a reload or a shared link resumes the same run.
const RUN_QUERY_PARAM = "run";
/** A run asked for by its address or the list that Eneo no longer has; the setup below it starts a new one. */
const RUN_GONE = "Körningen finns inte längre. Du kan starta en ny här.";

function readRunIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get(RUN_QUERY_PARAM);
}

/** The run a state shows, or null for the setup and a send under way. */
function runIdOf(run: RunState): string | null {
  switch (run.kind) {
    case "opening":
    case "unread":
      return run.runId;
    case "running":
    case "awaiting_review":
    case "done":
      return run.run.id;
    default:
      return null;
  }
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
  // Counts the person's "Försök igen" on a flow that is slow to load; each one loads it again.
  const [loadAttempt, setLoadAttempt] = useState(0);
  // The run's status cannot be read now, and is asked for again by itself.
  const [pollTrouble, setPollTrouble] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const [run, setRun] = useState<RunState>({ kind: "idle" });
  // Opened to send a recording from the flow list, or to record on in it: the page holds its loading state until that
  // send or recording has begun, and shows no screen of the flow on the way (the choice of audio, the finished recording).
  const [adopting, setAdopting] = useState(() => {
    const search = new URLSearchParams(window.location.search);
    return search.has(RECORDING_QUERY_PARAM) || search.has(CONTINUE_QUERY_PARAM);
  });
  useEffect(() => {
    if (run.kind !== "idle") setAdopting(false);
  }, [run.kind]);
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
      // The run goes on without its details: the page stops waiting for them.
      .catch(() => current && setStartedWith({ runId: runningRun.id, input: null }));
    return () => {
      current = false;
    };
    // Once per run shown running: the status reads that replace it later carry no details.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningRun?.id]);
  // This user's earlier runs of the flow, a page at a time.
  const [earlier] = useState(() => new EarlierRunsList(flowId));
  // Read again as a run's view is opened and as its run starts, ends or waits for review: the setup the person goes back to
  // (Ny inspelning, Back) is drawn with what was read, its latest runs as they are, and reads nothing that would fill a row
  // in above the form after it is shown.
  const runOnScreen = runIdOf(run) && `${runIdOf(run)} ${"run" in run ? (runOutcome(run.run.status) ?? run.run.status) : run.kind}`;
  useEffect(() => {
    if (runOnScreen) loadEarlierRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runOnScreen]);
  // Why Eneo would not continue the failed run on screen, and whether a new run is the way on.
  const [retryRefusal, setRetryRefusal] = useState<{ message: string; startAgain: boolean } | null>(null);

  const followAbortRef = useRef<AbortController | null>(null);
  const submitAbortRef = useRef<AbortController | null>(null);
  // The run's view on screen, ended when Back or Forward leaves it and when the page goes. An action started on it (a
  // retry, a cancellation, a review's answer, a new document) that Eneo answers after that is not shown: Eneo keeps what
  // it did, and the page stays where the person went.
  const runView = useRef(new AbortController());
  const leaveRunView = () => {
    runView.current.abort();
    runView.current = new AbortController();
  };
  // The files Eneo holds from a send the person cancelled: the next send of the same file asks for the run from them, as
  // the same request under the same key, instead of uploading again. Forgotten when a send fails any other way.
  const uploadedFiles = useRef(new WeakMap<Blob, string>());

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
  // What was said about the last run (one that is gone, one that could not be read) belongs to the setup it was said on:
  // a recording that starts there leaves it behind. Every other writer of it shows a run, where the setup is not drawn.
  useEffect(() => {
    if (snapshot.phase !== "setup") setRunError(null);
  }, [snapshot.phase]);
  const unsentList = useUnsentRecordings(user.id, flowId);
  const unsent = { ...unsentList, recordings: unsentList.recordings.filter((recording) => recording.id !== currentRecordingId) };

  useEffect(() => {
    let cancelled = false;
    const urlRunId = readRunIdFromUrl();
    // The setup's earlier runs are read beside the contract, and the setup is drawn once they are known (or could not be
    // read): the latest runs open the setup, and an answer that came later would move it. They are read once the flow
    // is: a flow that is gone has no runs to ask for.
    const flow = getPublishedFlow(flowId);
    // A load the page left (React's development double effect, Försök igen) starts no read of the runs: it would replace
    // the read this load waits for, and the setup would be drawn before its runs are known.
    Promise.all([flow, getRunContract(flowId), urlRunId ? null : flow.then(() => (cancelled ? undefined : earlier.reload()))])
      .then(async ([p, c]) => {
        if (cancelled) return;
        // The address as it is now: Back to the setup while the flow was read leaves the run it named, and the setup
        // reads its earlier runs before it is drawn, as on a load of its own.
        const runId = readRunIdFromUrl();
        if (urlRunId && !runId) await earlier.reload();
        if (cancelled) return;
        setPublished(p);
        setContract(c);
        if (runId) resumeRun(runId);
      })
      .catch((err) => !cancelled && setLoadError(err));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId, loadAttempt]);

  useEffect(() => {
    return () => {
      followAbortRef.current?.abort();
      submitAbortRef.current?.abort();
      leaveRunView();
      // Left: what the browser could not keep is gone with the page.
      unstoredDrafts.forget();
    };
  }, []);

  // Leaving asks first while audio is being recorded or waits to become a document (until Eneo has the run: an
  // upload, and its start, which may retry or wait for a new login), or typed work the browser could not keep.
  const holdsAudio = snapshot.phase !== "setup";
  const submitting = run.kind === "submitting";
  const unstored = useSyncExternalStore(unstoredDrafts.subscribe, unstoredDrafts.any, () => false);
  // Back or Forward to this flow's entry of another run, or of the setup, takes the run shown off the page (below): with
  // work held in it, that asks first too. With a recording on the page, the page stays as it is.
  const replacesShownRun = (next: { search: string }) => {
    const shown = runIdOf(run);
    return shown !== null && snapshot.phase === "setup" && new URLSearchParams(next.search).get(RUN_QUERY_PARAM) !== shown;
  };
  const leaving = useLeaveQuestion(
    submitting || holdsAudio || unstored,
    submitting || holdsAudio
      ? leaveWarning(input.persistent, snapshot.phase, submitting && (submission.kind === "starting" ? "starting" : "uploading"), input.capture.refused)
      : UNSTORED_LEAVE,
    leaveKeepsWork({ persistent: input.persistent, holdsAudio, sending: submitting, unstored }),
    replacesShownRun,
  );
  const asksOnClose = asksBeforeClosing({
    phase: snapshot.phase,
    persistent: input.persistent,
    refused: input.capture.refused,
    finishing: snapshot.finishing || snapshot.finishQueued,
    sending: submitting,
    unstored,
  });
  useEffect(() => {
    if (!asksOnClose) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [asksOnClose]);

  // A file dropped outside Ladda upp's zone would make the browser open it and leave the page (and a recording). The zone's
  // own handlers run first (React's root listeners are below window) and mark their event handled, so only a drop that
  // landed elsewhere is stopped here; nothing is chosen by it.
  useEffect(() => {
    const keepPage = (event: DragEvent) => {
      if (event.defaultPrevented || !event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      if (event.type === "dragover") event.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", keepPage);
    window.addEventListener("drop", keepPage);
    return () => {
      window.removeEventListener("dragover", keepPage);
      window.removeEventListener("drop", keepPage);
    };
  }, []);

  // Opened by "Skapa dokument" on an unsent recording in the flow list, or "Fortsätt spela in" on a cut-off one: the
  // recording is sent, or recorded on in as this page's own "Fortsätt spela in" does it, once the flow has loaded.
  useEffect(() => {
    if (!contract) return;
    const search = new URLSearchParams(window.location.search);
    const sending = search.get(RECORDING_QUERY_PARAM);
    const recordingId = sending ?? search.get(CONTINUE_QUERY_PARAM);
    if (!recordingId) return;
    writeSearch((search) => {
      search.delete(RECORDING_QUERY_PARAM);
      search.delete(CONTINUE_QUERY_PARAM);
    });
    recordingStore()
      .then((store) => store.get(recordingId))
      .then((recording) => {
        if (recording?.ownerId !== user.id || recording.flowId !== flowId) return;
        if (!sending) return session.getSnapshot().modes.includes("spela-in") ? session.continueCutOff(recording) : undefined;
        session.adopt(recording);
        return createDocument(session);
      })
      .catch(() => undefined)
      .finally(() => setAdopting(false));
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
          setSubmission({ kind: "uploading", ...progress, recording: runInput?.kind === "recording", wait: null }),
        onStarting: () =>
          setSubmission({
            kind: "starting",
            wait: null,
            recording: runInput?.kind === "recording" ? { id: runInput.recording.id, files: filesIn(runInput.recording) } : null,
          }),
        onWait: (wait: RetryWait | null) =>
          setSubmission((prev) => (prev.kind === "idle" ? prev : { ...prev, wait })),
      };
      const initialRun =
        runInput?.kind === "recording"
          ? await submitRecording(await recordingStore(), runInput.recording.id, params)
          : await submitRun({
              ...params,
              files: runInput ? [{ blob: runInput.blob, filename: runInput.filename, fileId: uploadedFiles.current.get(runInput.blob) }] : [],
              onUploaded: (_index, fileId) => void (runInput?.kind === "file" && uploadedFiles.current.set(runInput.blob, fileId)),
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
      if (!abortController.signal.aborted) uploadedFiles.current = new WeakMap();
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

  /** Takes up an existing run (from the address, or read again) and follows it. */
  function resumeRun(runId: string) {
    writeRunIdToUrl(runId);
    showRun(runId);
  }

  function showRun(runId: string) {
    setRunError(null);
    setRetryRefusal(null);
    setRun({ kind: "opening", runId });
    void follow(runId);
  }

  /** A run the person opens from the setup's list: an entry of its own, so Back goes to the setup it was opened from. */
  function openRun(runId: string) {
    const search = new URLSearchParams(window.location.search);
    search.set(RUN_QUERY_PARAM, runId);
    void navigate({ search: search.toString() });
    showRun(runId);
  }

  // Back and Forward between this flow's own entries (a run the person opened, and the setup they opened it from): the
  // page shows what the entry's address names. Not while a recording or a send is on the page: those stay where they are.
  const location = useLocation();
  const navigationType = useNavigationType();
  const seenEntry = useRef(location.key);
  useEffect(() => {
    if (seenEntry.current === location.key) return;
    seenEntry.current = location.key;
    if (navigationType !== "POP" || run.kind === "submitting" || snapshot.phase !== "setup") return;
    const wanted = new URLSearchParams(location.search).get(RUN_QUERY_PARAM);
    if (wanted === runIdOf(run)) return;
    leaveRunView();
    if (wanted) {
      showRun(wanted);
    } else {
      followAbortRef.current?.abort();
      setRunError(null);
      setRetryRefusal(null);
      setRun({ kind: "idle" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  /**
   * Follows the run by its status and its run-locked graph until it is done or waits for review. The step results (an
   * audit-logged read) and the detail are read once, when the run is done.
   */
  async function follow(runId: string) {
    // The run's text is formatted when it is first drawn (components/flow/Markdown).
    preloadMarkdown();
    preloadRunViews();
    followAbortRef.current?.abort();
    const controller = new AbortController();
    followAbortRef.current = controller;
    const { signal } = controller;
    setPollTrouble(false);
    try {
      const last = await followRun(flowId, runId, {
        signal,
        onTrouble: (failing) => !signal.aborted && setPollTrouble(failing),
        onSnapshot: ({ run: current, graph: runGraph }) => {
          if (runOutcome(current.status) || current.status === "awaiting_review") return;
          setRun({ kind: "running", run: current, graph: runGraph });
        },
      });
      if (!last || signal.aborted) return;
      if (last.run.status === "awaiting_review") {
        // Eneo answers null while the pause is not visible yet. An error is not that: it is said once, on the run's own
        // page with a way to read it again, and not polled (the run waits for this person in Eneo; the start page would
        // invite a second run).
        let pause: Awaited<ReturnType<typeof readActivePause>>;
        try {
          pause = await readActivePause(flowId, runId);
        } catch (err) {
          if (!signal.aborted) setRun({ kind: "unread", runId, message: friendlyError(err), review: true });
          return;
        }
        const { checkpoint, corrections } = pause;
        if (signal.aborted) return;
        if (checkpoint) {
          // Paused until the person has acted; the review view starts the following again.
          setRun({ kind: "awaiting_review", run: last.run as FlowRunPublic, steps: [], checkpoint, corrections });
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
      setRun({ kind: "done", run: finished.run, steps: finished.steps, graph: last.graph, corrections: finished.corrections });
    } catch (err) {
      if (signal.aborted) return;
      setPollTrouble(false);
      // A run that no longer exists (an old link, a run removed in Eneo) leaves the address too, so a reload does not
      // ask for it again.
      const gone = err instanceof ApiError && (err.status === 404 || err.status === 410);
      if (gone) writeRunIdToUrl(null);
      // The run the person meant may be among the earlier ones, which a page opened at a run's address has not read: the
      // setup is drawn once they are, as on a load of its own.
      await earlier.reload();
      if (signal.aborted) return;
      setRunError(gone ? RUN_GONE : friendlyError(err));
      setRun({ kind: "idle" });
    }
  }

  async function onCancelRun(runId: string) {
    setRunError(null);
    const { signal } = runView.current;
    try {
      await cancelRun(flowId, runId);
    } catch (err) {
      if (!signal.aborted) setRunError(friendlyError(err));
      return;
    }
    // The cancelled run is read now, not at the next poll.
    if (!signal.aborted) void follow(runId);
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
    const { signal } = runView.current;
    const hold = (cp: FlowRunReviewCheckpointPublic) =>
      !signal.aborted && setRun((prev) => (prev.kind === "awaiting_review" ? { ...prev, checkpoint: cp } : prev));
    try {
      const resumedRun = await continueFromPause({ flowId, runId, checkpoint, edit, onCheckpoint: hold, onHeld: onSaved });
      if (signal.aborted) return null;
      setRun({ kind: "running", run: resumedRun, graph: null });
      void follow(resumedRun.id);
      return null;
    } catch (err) {
      const message = describe(err);
      if (signal.aborted) return message;
      if (reviewPauseEnded(err)) {
        readRunAgain(runId);
        return message;
      }
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
    const { signal } = runView.current;
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
      if (signal.aborted) return updated;
      setRun((prev) =>
        prev.kind === "awaiting_review"
          ? { ...prev, checkpoint: updated }
          : prev,
      );
      return updated;
    } catch (err) {
      const message = describe(err);
      if (signal.aborted) return { error: message };
      if (reviewPauseEnded(err)) {
        readRunAgain(checkpoint.flow_run_id);
        return { error: message };
      }
      setRunError(message);
      // After e.g. a stale revision: the current checkpoint is read, so that the form follows the server's version
      // before the person tries again.
      const latest = await getActiveReviewCheckpoint(
        flowId,
        checkpoint.flow_run_id,
      ).catch(() => null);
      if (latest && latest.id === checkpoint.id && !signal.aborted) {
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
    const { signal } = runView.current;
    try {
      await rejectReviewCheckpoint(flowId, runId, checkpoint.id, {
        expected_checkpoint_revision: checkpoint.revision,
        reason,
      });
      // The run is cancelled: followed to its end, so that its steps and result are read as usual.
      if (!signal.aborted) void follow(runId);
    } catch (err) {
      if (signal.aborted) return;
      if (reviewPauseEnded(err)) return readRunAgain(runId);
      setRunError(friendlyError(err));
    }
  }

  /**
   * The review is over (it ran out, was decided elsewhere, or the run ended), so its buttons would only fail: the run
   * is read again, and its state, whatever it is, replaces the review.
   */
  function readRunAgain(runId: string) {
    setRunError(null);
    void follow(runId);
  }

  /** A new recording: the same flow and details (the participants); the session let go of the audio when it was sent. */
  function onRunAgain() {
    followAbortRef.current?.abort();
    setRunError(null);
    setRetryRefusal(null);
    writeRunIdToUrl(null);
    setRun({ kind: "idle" });
  }

  /** "Försök igen": Eneo continues the failed run from its first unfinished step in a new run; what was finished is not done again. */
  async function onRetry(failed: Extract<RunState, { kind: "done" }>) {
    setRunError(null);
    setRetryRefusal(null);
    const { signal } = runView.current;
    const outcome = await retryFailedRun(flowId, failed.run.id);
    // The view was left while Eneo answered: nothing is shown or followed from here.
    if (signal.aborted) return;
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

  const holding = adopting && run.kind === "idle";
  useRouteReady(loadError !== null || (published !== null && contract !== null && !holding));
  const content = (): ReactNode => {
    if (loadError) return <FlowUnavailable error={loadError} />;
    if (holding) return <FlowSkeleton onRetry={() => window.location.reload()} />;
    if (!published || !contract) return <FlowSkeleton onRetry={() => setLoadAttempt((n) => n + 1)} />;

    if (run.kind === "idle") {
      return (
        <FlowInput
          published={published}
          contract={contract}
          input={input}
          ownerId={user.id}
          notice={runError}
          earlier={earlier}
          onOpenRun={openRun}
          unsent={unsent}
          afterRun={shownRun}
        />
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
      return flowPage(
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
        },
      );
    }

    if (run.kind === "awaiting_review") {
      return (
        // The review's own heading names the state, and its first line the flow.
        <FlowFrame>
          <WithRunViews>
            {({ ReviewView }) => (
              <ReviewView
                flowId={flowId}
                flowName={published.name}
                checkpoint={run.checkpoint}
                runState={{ run: run.run, steps: run.steps }}
                savedCorrections={run.corrections}
                runError={runError}
                onContinue={(cp, edit, options) => onContinue(cp, run.run.id, edit, options)}
                onSaveEdit={onSaveEdit}
                onReject={(cp, reason) => onReject(cp, run.run.id, reason)}
              />
            )}
          </WithRunViews>
        </FlowFrame>
      );
    }

    if (run.kind === "opening") return flowPage(<RunOpening retrying={pollTrouble} onRetry={() => void follow(run.runId)} />);

    if (run.kind === "unread") return flowPage(<RunUnread message={run.message} review={run.review} onRetry={() => resumeRun(run.runId)} />);

    if (run.kind === "running") {
      // What the run was started with: what the page holds for it, or the run's own where it carries it. A run opened
      // while it runs is read once more for it (above), and the page waits for that read as it waited for the run:
      // details that arrive above a card already drawn move the card, on a phone by the height of their line.
      const started =
        startedWith.runId === run.run.id
          ? startedWith
          : "input_payload_json" in run.run
            ? { input: (run.run as FlowRunPublic).input_payload_json ?? null, speakerLabels: (run.run as FlowRunPublic).speaker_labels }
            : null;
      if (!started) return flowPage(<RunOpening retrying={pollTrouble} onRetry={() => void follow(run.run.id)} />);
      const steps = runSteps(run.graph, run.run, [], contract);
      return flowPage(
        <RunProgress
          flowName={published.name}
          steps={steps}
          stage={runStage(
            steps,
            run.run.status,
            runLabelsSpeakers(started.speakerLabels, contract.transcription?.speaker_labels, ofContractVersion(run.run, contract)),
          )}
          startedAt={run.run.created_at}
          error={runError}
          retrying={pollTrouble ? { onRetry: () => void follow(run.run.id) } : null}
          // Today's contract speaks only for a run of its own version.
          makesText={ofContractVersion(run.run, contract) && makesText(contract.final_output)}
          unattended={finishesUnattended(run.run, contract)}
          onCancel={() => onCancelRun(run.run.id)}
        />,
        { input: started.input, version: run.run.flow_version, offline: "run" },
      );
    }

    const { steps, transcribed, stepLabels } = finishedRun(run.graph, run.run, run.steps);
    const files = resultFileViews(run.run.result_files ?? []);
    const inputStep = selectRuntimeInputStep(contract);
    if (runOutcome(run.run.status) === "succeeded") {
      const view = runView.current.signal;
      return (
        // The result has its own layout; its heading names the state, and the line under it the flow.
        <FlowFrame>
          <WithRunViews>
            {({ RunResult }) => (
              <RunResult
                flowId={flowId}
                flowName={published.name}
                run={run.run}
                steps={steps}
                stepResults={run.steps}
                savedCorrections={run.corrections}
                files={files}
                showTranscript={transcribed}
                contract={contract}
                audio={inputStep?.input_format?.toLowerCase() === "audio"}
                onNewRecording={onRunAgain}
                onStartAgain={startAgainRequest(run.run, run.steps, contract) !== null ? () => void onStartAgain(run) : undefined}
                onRegenerated={(regenerated) => {
                  if (view.aborted) return;
                  // The new run is followed like any other, from its progress to its own result.
                  setRunError(null);
                  writeRunIdToUrl(regenerated.id);
                  setRun({ kind: "running", run: regenerated, graph: null });
                  void follow(regenerated.id);
                }}
              />
            )}
          </WithRunViews>
        </FlowFrame>
      );
    }
    const failure = run.run.error ? runErrorView(run.run.error, stepLabels, ofContractVersion(run.run, contract) ? inputStep : null) : null;
    // The same audio cannot help when the input itself has to change.
    const sameInputHelps = !failure?.inputMustChange;
    const cancelled = runOutcome(run.run.status) === "cancelled";
    const startAgainOffered = sameInputHelps && startAgainRequest(run.run, run.steps, contract) !== null;
    return flowPage(
      <WithRunViews>
        {({ RunFailure }) => (
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
          />
        )}
      </WithRunViews>,
      { input: run.run.input_payload_json, version: run.run.flow_version },
    );
  };

  return (
    <LeaveContext.Provider value={leaving}>
      {content()}
      {leaving.question}
    </LeaveContext.Provider>
  );
}
