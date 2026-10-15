/**
 * Follows a run while it goes, reading only what is made for polling: the run
 * status and the run-pinned graph (the step results are audited per read, so
 * they are read once, after the end). Stops when the run ends or waits for a
 * review, and polls rarely while the page is hidden.
 */

import {
  getActiveReviewCheckpoint,
  getRun,
  getRunGraph,
  getRunStatus,
  getRunSteps,
  listTranscriptCorrections,
  type FlowGraph,
  type FlowRunPublic,
  type FlowRunReviewCheckpointPublic,
  type FlowRunStep,
  type FlowRunSummary,
  type TranscriptCorrectionsPublic,
} from "./api";
import { onlineStatus, type OnlineStatus } from "./online-status";
import { runOutcome } from "./run-progress";
import { isSpeakerMappingCheckpoint } from "./speaker-mapping";
import { carriesTranscript } from "./speaker-review";
import { withRetry } from "./submit-run";

/**
 * The transcript's saved corrections as a page read them beside what it needs first: the sets; null when the read
 * failed; `{ reading }` when it had not answered within CORRECTIONS_WAIT_MS, and the transcript waits for that same read
 * rather than ask again; undefined when they were not read. The transcript takes them from there (loadTranscriptContext).
 */
export type SavedCorrections =
  | TranscriptCorrectionsPublic[]
  | null
  | { reading: Promise<TranscriptCorrectionsPublic[] | null> }
  | undefined;

/** The saved corrections when they were read in time, for what the page draws first: no sets otherwise. */
export const savedSets = (saved: SavedCorrections): TranscriptCorrectionsPublic[] | null => (Array.isArray(saved) ? saved : null);

/** How long a page waits for the saved corrections before it is drawn without them. */
export const CORRECTIONS_WAIT_MS = 3_000;

/** Starts reading the saved corrections at once; the returned function waits for them, at most CORRECTIONS_WAIT_MS. */
function readSavedCorrections(flowId: string, runId: string): () => Promise<SavedCorrections> {
  const reading = listTranscriptCorrections(flowId, runId).then(
    (sets) => sets,
    () => null,
  );
  return () => {
    let late!: (value: { reading: typeof reading }) => void;
    const lateness = new Promise<{ reading: typeof reading }>((resolve) => (late = resolve));
    const timer = setTimeout(() => late({ reading }), CORRECTIONS_WAIT_MS);
    return Promise.race([reading, lateness]).finally(() => clearTimeout(timer));
  };
}

/**
 * A finished run's detail (its result) and step results, read once at the
 * end. Either read failing fails the whole: an empty stand-in would show a
 * finished run without its document or transcript.
 *
 * A result that shows a transcript also waits for its saved corrections, read beside them, so it knows from its first
 * draw whether the document is older than they are (RunResult); any other run is drawn as soon as it is read.
 */
export async function readFinishedRun(
  flowId: string,
  last: FlowRunSummary,
): Promise<{ run: FlowRunPublic; steps: FlowRunStep[]; corrections: SavedCorrections }> {
  const corrections = readSavedCorrections(flowId, last.id);
  const [run, steps] = await Promise.all([getRun(flowId, last.id), getRunSteps(flowId, last.id)]);
  const showsTranscript = runOutcome(run.status) === "succeeded" && steps.some(carriesTranscript);
  return { run, steps, corrections: showsTranscript ? await corrections() : undefined };
}

/**
 * The run's active review pause, or null while Eneo does not show it yet. Naming the speakers also waits for the saved
 * corrections, read beside it, so the speakers they add are in the review's list from its first draw; a text review is
 * drawn as soon as the pause is read.
 */
export async function readActivePause(
  flowId: string,
  runId: string,
): Promise<{ checkpoint: FlowRunReviewCheckpointPublic | null; corrections: SavedCorrections }> {
  const corrections = readSavedCorrections(flowId, runId);
  const checkpoint = await getActiveReviewCheckpoint(flowId, runId);
  const naming = checkpoint !== null && isSpeakerMappingCheckpoint(checkpoint.current_payload_json ?? null);
  return { checkpoint, corrections: naming ? await corrections() : undefined };
}

export const VISIBLE_POLL_MS = 2_000;
export const HIDDEN_POLL_MS = 30_000;

export interface RunSnapshot {
  run: FlowRunSummary;
  graph: FlowGraph | null;
}

export interface PageVisibility {
  readonly hidden: boolean;
  /** Calls back when the page is shown again; returns the unsubscribe. */
  onVisible(callback: () => void): () => void;
}

interface FollowOptions {
  signal: AbortSignal;
  onSnapshot: (snapshot: RunSnapshot) => void;
  /** Heard when the status cannot be read (true, from the first failed read) and when a read goes through again (false). */
  onTrouble?: (failing: boolean) => void;
  page?: PageVisibility;
  online?: OnlineStatus;
  deps?: { getStatus: typeof getRunStatus; getGraph: typeof getRunGraph };
}

/** The last snapshot once the run ended or waits for review; null when aborted. */
export async function followRun(
  flowId: string,
  runId: string,
  {
    signal,
    onSnapshot,
    onTrouble,
    page = documentVisibility(),
    online = onlineStatus,
    deps = { getStatus: getRunStatus, getGraph: getRunGraph },
  }: FollowOptions,
): Promise<RunSnapshot | null> {
  let graph: FlowGraph | null = null;
  let failing = false;
  const inTrouble = (now: boolean) => {
    if (now !== failing) onTrouble?.((failing = now));
  };
  while (!signal.aborted) {
    // The run goes on in Eneo when the connection drops; follow it again when it is back.
    const [run, latest] = await withRetry(
      async () => {
        try {
          const read = await Promise.all([deps.getStatus(flowId, runId), deps.getGraph(flowId, runId).catch(() => null)]);
          inTrouble(false);
          return read;
        } catch (error) {
          inTrouble(true);
          throw error;
        }
      },
      { online, signal },
    );
    if (signal.aborted) break;
    graph = latest ?? graph;
    const snapshot = { run, graph };
    onSnapshot(snapshot);
    if (runOutcome(run.status) || run.status === "awaiting_review") return snapshot;
    await pause(page.hidden ? HIDDEN_POLL_MS : VISIBLE_POLL_MS, signal, page);
  }
  return null;
}

function pause(ms: number, signal: AbortSignal, page: PageVisibility): Promise<void> {
  return new Promise((resolve) => {
    let stopWatching = () => {};
    const done = () => {
      clearTimeout(timer);
      stopWatching();
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (page.hidden) stopWatching = page.onVisible(done);
    signal.addEventListener("abort", done, { once: true });
  });
}

function documentVisibility(): PageVisibility {
  return {
    get hidden() {
      return typeof document !== "undefined" && document.visibilityState === "hidden";
    },
    onVisible(callback) {
      const onChange = () => document.visibilityState === "visible" && callback();
      document.addEventListener("visibilitychange", onChange);
      return () => document.removeEventListener("visibilitychange", onChange);
    },
  };
}
