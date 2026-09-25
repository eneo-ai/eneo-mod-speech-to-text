/**
 * What a run's steps are doing, in words. While the run goes, the run-pinned
 * graph carries each step's status (an unaudited read, so it can be polled);
 * once it ended, the step results read once say which steps ever started.
 */

import { isSpeakerMappingReviewStep, type FlowGraph, type FlowReviewStepContract, type FlowRunError, type FlowRunStep, type RunContract } from "./api";
import { carriesTranscript } from "./speaker-review";

export type StepState = "waiting" | "running" | "done" | "failed" | "cancelled" | "not_run";

export interface StepView {
  order: number;
  label: string;
  state: StepState;
  /** The step reads the recording, so while it runs it is transcribing. */
  transcribes: boolean;
  /** What a step that stops for the person will ask of them, said while it is still ahead. */
  note: string | null;
}

export type RunOutcome = "succeeded" | "failed" | "cancelled";

const OUTCOMES: Record<string, RunOutcome> = {
  completed: "succeeded",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
};

/** The run's end, or null while it can still change. */
export function runOutcome(status: string): RunOutcome | null {
  return OUTCOMES[status.toLowerCase()] ?? null;
}

const STATUS_LABELS: Record<string, string> = {
  succeeded: "Klar",
  failed: "Misslyckades",
  cancelled: "Avbröts",
  running: "Pågår",
  queued: "Väntar på att starta",
  awaiting_review: "Väntar på granskning",
};

export function runStatusLabel(status: string): string {
  const s = status.toLowerCase();
  return STATUS_LABELS[runOutcome(s) ?? s] ?? "Pågår";
}

const STATE_LABELS: Record<StepState, string> = {
  waiting: "Väntar",
  running: "Pågår",
  done: "Klar",
  failed: "Misslyckades",
  cancelled: "Avbröts",
  not_run: "Kördes inte",
};

export function stepStateLabel(state: StepState): string {
  return STATE_LABELS[state];
}

/**
 * A finished run as the result views show it: its steps, whether its results
 * hold a transcript, and step names by id. Only the run's own graph names its
 * steps; without it the results stand alone, never the flow's current
 * publication, whose steps may be other steps than this run's.
 */
export function finishedRun(
  runGraph: FlowGraph | null,
  run: { status: string; error?: Pick<FlowRunError, "step_order"> | null },
  results: readonly FlowRunStep[],
): { steps: StepView[]; transcribed: boolean; stepLabels: Record<string, string> } {
  return {
    steps: runSteps(runGraph, run, results),
    transcribed: results.some(carriesTranscript),
    stepLabels: Object.fromEntries((runGraph?.nodes ?? []).map((node) => [node.id, node.label])),
  };
}

/**
 * Whether the run was started on the flow's version the contract describes. A republished flow can have other
 * steps and other fields, so today's contract says nothing about an older run; an unknown version is not guessed.
 */
export function ofContractVersion(
  run: { flow_version?: number | null },
  contract: Pick<RunContract, "published_flow_version"> | null | undefined,
): boolean {
  return run.flow_version != null && run.flow_version === contract?.published_flow_version;
}

/** The run contract's word for what a review step asks: naming the speakers, or looking over a result. */
function reviewNote(review: FlowReviewStepContract | undefined): string | null {
  if (!review) return null;
  return isSpeakerMappingReviewStep(review) ? "Här bekräftar du vem som är vem." : "Här granskar du resultatet.";
}

export function runSteps(
  graph: FlowGraph | null,
  run: { status: string; flow_version?: number | null; error?: Pick<FlowRunError, "step_order"> | null },
  results: readonly FlowRunStep[] = [],
  /** The run contract, for the steps that pause the run for the person; used only for the run's own version. */
  contract?: Pick<RunContract, "published_flow_version" | "steps_requiring_review"> | null,
): StepView[] {
  const reviews = ofContractVersion(run, contract) ? (contract?.steps_requiring_review ?? []) : [];
  const outcome = runOutcome(run.status);
  const failedAt = run.error?.step_order ?? null;
  const byId = new Map(results.map((result) => [result.step_id, result]));
  const nodes = (graph?.nodes ?? []).filter((n) => typeof n.step_order === "number");
  const rows = nodes.length
    ? nodes.map((n) => ({
        order: n.step_order as number,
        label: n.label,
        transcribes: n.input_type === "audio",
        status: byId.get(n.id)?.status ?? n.run_status ?? null,
        result: byId.get(n.id),
        review: reviews.find((review) => review.step_id === n.id),
      }))
    : results.map((result) => ({
        order: result.step_order ?? 0,
        label: `Steg ${result.step_order ?? 0}`,
        transcribes: false,
        status: result.status,
        result: result as FlowRunStep | undefined,
        review: reviews.find((review) => review.step_id === result.step_id),
      }));

  return rows
    .sort((a, b) => a.order - b.order)
    .map(({ order, label, transcribes, status, result, review }) => {
      const s = status?.toLowerCase();
      let state: StepState;
      if (s === "completed") state = "done";
      else if (s === "running") state = outcome ? (outcome === "cancelled" ? "cancelled" : "failed") : "running";
      else if (s === "failed" || s === "cancelled") {
        // Eneo closes the steps that never started along with the run.
        const neverStarted = result ? !result.started_at : failedAt !== null && order > failedAt;
        state = neverStarted ? "not_run" : s;
      } else state = outcome ? "not_run" : "waiting";
      return { order, label, transcribes, state, note: state === "waiting" ? reviewNote(review) : null };
    });
}

/** One line for what happens now; truthful between steps, never a percentage. */
export function runStage(steps: readonly StepView[], runStatus: string): string {
  if (runStatus.toLowerCase() === "queued") return "Väntar på att starta";
  const running = steps.find((step) => step.state === "running");
  if (running) return running.transcribes ? "Transkriberar ljudet" : running.label;
  if (steps.length === 0) return "Körningen pågår";
  if (steps.every((step) => step.state === "done")) return "Slutför körningen";
  if (steps.some((step) => step.state === "done")) return "Väntar på nästa steg";
  return "Startar körningen";
}
