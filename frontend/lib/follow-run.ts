/**
 * Follows a run while it goes, reading only what is made for polling: the run
 * status and the run-pinned graph (the step results are audited per read, so
 * they are read once, after the end, and once more while it goes when a step
 * decides against its live text). Stops when the run ends or waits for a
 * review, and polls rarely while the page is hidden.
 */

import {
  ApiError,
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
import { deliveryUnderWay } from "./run-result";
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
  /** The step results, read once when the graph first says a step's live text is not used: they name the model. */
  steps: FlowRunStep[];
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
  deps?: { getStatus: typeof getRunStatus; getGraph: typeof getRunGraph; getSteps?: typeof getRunSteps };
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
    deps = { getStatus: getRunStatus, getGraph: getRunGraph, getSteps: getRunSteps },
  }: FollowOptions,
): Promise<RunSnapshot | null> {
  let graph: FlowGraph | null = null;
  let steps: FlowRunStep[] | null = null;
  let failing = false;
  const inTrouble = (now: boolean) => {
    if (now !== failing) onTrouble?.((failing = now));
  };
  while (!signal.aborted) {
    // The run goes on in Eneo when the connection drops; follow it again when it is back.
    const [run, latest] = await withRetry(
      async () => {
        try {
          // The signal calls off the status read too, also one that waits for a new login: none is sent for a run left.
          const read = await Promise.all([deps.getStatus(flowId, runId, signal), deps.getGraph(flowId, runId).catch(() => null)]);
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
    // A step decided against its live text: its results are read once, for the model's name (a failed read leaves the
    // notice without it).
    if (steps === null && graph?.nodes.some((node) => node.live_fallback_reason)) {
      steps = await (deps.getSteps ?? getRunSteps)(flowId, runId).catch(() => []);
      if (signal.aborted) break;
    }
    const snapshot = { run, graph, steps: steps ?? [] };
    onSnapshot(snapshot);
    if (runOutcome(run.status) || run.status === "awaiting_review") return snapshot;
    await pause(page.hidden ? HIDDEN_POLL_MS : VISIBLE_POLL_MS, signal, page);
  }
  return null;
}

/**
 * How long to wait before reading a sending again, by how long it has stood in the same state: often at first, when a
 * receiver usually answers, then more rarely (Eneo's advice to its clients). Never by the planned retry time: a time
 * that has passed must not make a read without a wait.
 */
const deliveryPace = (unchangedMs: number) => (unchangedMs < 30_000 ? 2_000 : unchangedMs < 120_000 ? 5_000 : 15_000);

interface DeliveryOptions {
  signal: AbortSignal;
  /** Heard with a status read whose sending changed (its state or its planned retry), never with one that did not. */
  onStatus: (status: FlowRunSummary) => void;
  /** As followRun's: from the first failed read (true) until a read goes through again (false). */
  onTrouble?: (failing: boolean) => void;
  page?: PageVisibility;
  online?: OnlineStatus;
  deps?: { getStatus: typeof getRunStatus };
}

/** The answers that end the sending's follow: the run is gone, or this person may not read it (any more). */
const ENDS_DELIVERY_FOLLOW = new Set([401, 403, 404, 410]);

/**
 * Follows a finished run's result on its way to the receiver, from the status the run finished with, reading the status
 * alone (not audit-logged, unlike the detail, which would say nothing more): while the sending is under way, until it is
 * delivered, given up, or in a state the module does not know. A read that fails and can be tried again is tried again
 * with withRetry's backoff and reported as trouble. Any other failure is also reported as trouble and read again at the
 * follow's own pace, so the result on the page stays: only a run that is gone (404, 410) or a read that is refused (401,
 * the module's own end of the session too, and 403) ends it, thrown, as followRun's do. The signal calls off the read
 * under way too, also one that waits for a new login.
 */
export async function followDelivery(
  flowId: string,
  runId: string,
  first: FlowRunSummary,
  { signal, onStatus, onTrouble, page = documentVisibility(), online = onlineStatus, deps = { getStatus: getRunStatus } }: DeliveryOptions,
): Promise<void> {
  let delivery = first.result_delivery;
  let since = Date.now();
  let failing = false;
  const inTrouble = (now: boolean) => {
    if (now !== failing) onTrouble?.((failing = now));
  };
  while (deliveryUnderWay(delivery) && !signal.aborted) {
    await pause(page.hidden ? HIDDEN_POLL_MS : deliveryPace(Date.now() - since), signal, page);
    if (signal.aborted) return;
    let status: FlowRunSummary;
    try {
      status = await withRetry(
        async () => {
          try {
            const read = await deps.getStatus(flowId, runId, signal);
            inTrouble(false);
            return read;
          } catch (error) {
            if (!signal.aborted) inTrouble(true);
            throw error;
          }
        },
        { online, signal },
      );
    } catch (error) {
      if (signal.aborted || (error instanceof ApiError && ENDS_DELIVERY_FOLLOW.has(error.status))) throw error;
      // Said as trouble already (above); the next read is the pace's, never sooner.
      continue;
    }
    if (signal.aborted) return;
    const next = status.result_delivery;
    if (next?.state === delivery?.state && (next?.next_delivery_at ?? null) === (delivery?.next_delivery_at ?? null)) continue;
    delivery = next;
    since = Date.now();
    onStatus(status);
  }
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
