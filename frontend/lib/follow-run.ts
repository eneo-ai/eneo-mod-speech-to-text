/**
 * Follows a run while it goes, reading only what is made for polling: the run
 * status and the run-pinned graph (the step results are audited per read, so
 * they are read once, after the end). Stops when the run ends or waits for a
 * review, and polls rarely while the page is hidden.
 */

import { getRunGraph, getRunStatus, type FlowGraph, type FlowRunSummary } from "./api";
import { onlineStatus, type OnlineStatus } from "./online-status";
import { runOutcome } from "./run-progress";
import { withRetry } from "./submit-run";

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

export interface FollowOptions {
  signal: AbortSignal;
  onSnapshot: (snapshot: RunSnapshot) => void;
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
    page = documentVisibility(),
    online = onlineStatus,
    deps = { getStatus: getRunStatus, getGraph: getRunGraph },
  }: FollowOptions,
): Promise<RunSnapshot | null> {
  let graph: FlowGraph | null = null;
  while (!signal.aborted) {
    // The run goes on in Eneo when the connection drops; follow it again when it is back.
    const [run, latest] = await withRetry(
      () => Promise.all([deps.getStatus(flowId, runId), deps.getGraph(flowId, runId).catch(() => null)]),
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
