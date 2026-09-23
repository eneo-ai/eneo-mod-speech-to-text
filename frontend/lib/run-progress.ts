/**
 * What a run's steps are doing, in words. While the run goes, the run-pinned
 * graph carries each step's status (an unaudited read, so it can be polled);
 * once it ended, the step results read once say which steps ever started.
 */

import type { FlowGraph, FlowRunError, FlowRunStep } from "./api";

export type StepState = "waiting" | "running" | "done" | "failed" | "cancelled" | "not_run";

export interface StepView {
  order: number;
  label: string;
  state: StepState;
  /** The step reads the recording, so while it runs it is transcribing. */
  transcribes: boolean;
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

export function runSteps(
  graph: FlowGraph | null,
  run: { status: string; error?: Pick<FlowRunError, "step_order"> | null },
  results: readonly FlowRunStep[] = [],
): StepView[] {
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
      }))
    : results.map((result) => ({
        order: result.step_order ?? 0,
        label: `Steg ${result.step_order ?? 0}`,
        transcribes: false,
        status: result.status,
        result: result as FlowRunStep | undefined,
      }));

  return rows
    .sort((a, b) => a.order - b.order)
    .map(({ order, label, transcribes, status, result }) => {
      const s = status?.toLowerCase();
      let state: StepState;
      if (s === "completed") state = "done";
      else if (s === "running") state = outcome ? (outcome === "cancelled" ? "cancelled" : "failed") : "running";
      else if (s === "failed" || s === "cancelled") {
        // Eneo closes the steps that never started along with the run.
        const neverStarted = result ? !result.started_at : failedAt !== null && order > failedAt;
        state = neverStarted ? "not_run" : s;
      } else state = outcome ? "not_run" : "waiting";
      return { order, label, transcribes, state };
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
