import assert from "node:assert/strict";
import test from "node:test";

import type { FlowGraph, FlowGraphNode, FlowReviewStepContract, FlowRunStep } from "./api";
import { finishedRun, runElapsed, runOutcome, runStage, runStatusLabel, runSteps, stepStateLabel, streamedRun } from "./run-progress";

const node = (order: number, label: string, extra: Partial<FlowGraphNode> = {}): FlowGraphNode => ({
  id: `step-${order}`,
  label,
  type: "llm",
  step_order: order,
  input_source: order === 1 ? "flow_input" : "previous_step",
  input_type: order === 1 ? "audio" : "text",
  output_type: order === 4 ? "pdf" : "text",
  output_mode: null,
  ...extra,
});

const graph = (...statuses: (string | null)[]): FlowGraph => ({
  nodes: [
    { id: "input", label: "Input", type: "input", step_order: null, input_source: null, input_type: null, output_type: null, output_mode: null },
    ...["Transkribera mötet", "Analysera mötesinnehållet", "Skriv sammanfattning", "Skapa rapport"].map((label, i) =>
      node(i + 1, label, { run_status: statuses[i] ?? null }),
    ),
    { id: "output", label: "Output", type: "output", step_order: null, input_source: null, input_type: null, output_type: null, output_mode: null },
  ],
  edges: [],
});

const result = (order: number, status: string, started: boolean): FlowRunStep => ({
  id: `result-${order}`,
  step_id: `step-${order}`,
  step_order: order,
  status,
  started_at: started ? "2026-09-23T14:02:01Z" : undefined,
});

const states = (views: { state: string }[]) => views.map((view) => view.state);

test("a running run shows each step from the run-pinned graph, never 'I kö' for a running step", () => {
  const views = runSteps(graph("completed", "running", "pending", null), { status: "running" });

  assert.deepEqual(states(views), ["done", "running", "waiting", "waiting"]);
  assert.deepEqual(views.map((view) => view.label), [
    "Transkribera mötet",
    "Analysera mötesinnehållet",
    "Skriv sammanfattning",
    "Skapa rapport",
  ]);
  assert.deepEqual(views.map((view) => stepStateLabel(view.state)), ["Klar", "Pågår", "Väntar", "Väntar"]);
  assert.ok(views.every((view) => stepStateLabel(view.state) !== "I kö"));
});

test("a step that stops for the person says what it will ask, while it is still ahead, from the contract and not the name", () => {
  const contract = {
    published_flow_version: 3,
    steps_requiring_review: [
      {
        step_id: "step-2",
        step_order: 2,
        review_mode: "edit",
        output_type: "json",
        output_contract: { properties: { speakers: { items: { properties: { label: { pattern: "^SPEAKER_\\d{2,}$" } } } } } },
      },
      // Named like the speaker step, but an ordinary review of the text.
      { step_id: "step-3", step_order: 3, label: "Vem är vem?", review_mode: "view", output_type: "text" },
    ] as FlowReviewStepContract[],
  };
  const notes = (views: { note: string | null }[]) => views.map((view) => view.note);
  const running = { status: "running", flow_version: 3 };

  const ahead = runSteps(graph("running", null, null, null), running, [], contract);
  assert.deepEqual(notes(ahead), [null, "Här bekräftar du vem som är vem.", "Här granskar du resultatet.", null]);

  const passed = runSteps(graph("completed", "completed", "running", null), running, [], contract);
  assert.deepEqual(notes(passed), [null, null, null, null], "said only while the step is ahead");
  assert.deepEqual(notes(runSteps(graph("running", null, null, null), running)), [null, null, null, null]);
});

test("a run of an earlier version of the flow gets no review notes from today's contract, nor one whose version is unknown", () => {
  const contract = {
    published_flow_version: 4,
    steps_requiring_review: [{ step_id: "step-2", step_order: 2, review_mode: "view", output_type: "text" }] as FlowReviewStepContract[],
  };
  const notes = (flowVersion?: number) =>
    runSteps(graph("running", null, null, null), { status: "running", flow_version: flowVersion }, [], contract).map((view) => view.note);
  assert.deepEqual(notes(4), [null, "Här granskar du resultatet.", null, null], "the run of today's version");
  assert.deepEqual(notes(3), [null, null, null, null], "republished since the run started");
  assert.deepEqual(notes(undefined), [null, null, null, null], "never guessed");
});

test("the stage line names what happens now, and waits truthfully between steps", () => {
  assert.equal(runStage(runSteps(graph(), { status: "queued" }), "queued"), "Väntar på att starta");
  assert.equal(runStage(runSteps(graph("pending"), { status: "running" }), "running"), "Startar körningen");
  // Without the graph nothing is known about the steps, so nothing is claimed.
  assert.equal(runStage([], "running"), "Körningen pågår");
  assert.equal(runStage(runSteps(graph("running"), { status: "running" }), "running"), "Transkriberar ljudet");
  assert.equal(
    runStage(runSteps(graph("completed", "running"), { status: "running" }), "running"),
    "Analysera mötesinnehållet",
  );
  assert.equal(
    runStage(runSteps(graph("completed", "pending"), { status: "running" }), "running"),
    "Väntar på nästa steg",
  );
  assert.equal(
    runStage(runSteps(graph("completed", "completed", "completed", "completed"), { status: "running" }), "running"),
    "Slutför körningen",
  );
});

test("a run on streamed text says it labels or prepares that text, never that it transcribes the audio", () => {
  const selectable = { selectable: true, required: false, default: false };
  const live = { "step-audio": { file_ids: ["file-1"], live_transcript_id: "transcript-1" } };
  const labelling = streamedRun({ expected_flow_version: 3, step_inputs: live, speaker_labels: true }, selectable);
  const plain = streamedRun({ expected_flow_version: 3, step_inputs: live, speaker_labels: false }, selectable);
  const required = streamedRun({ expected_flow_version: 3, step_inputs: live }, { selectable: false, required: true, default: true });
  const transcribed = streamedRun({ expected_flow_version: 3, step_inputs: { "step-audio": { file_ids: ["file-1"] } } }, selectable);
  const audioRunning = runSteps(graph("running"), { status: "running" });
  assert.equal(runStage(audioRunning, "running", labelling), "Märker upp talare i den strömmade texten");
  assert.equal(runStage(audioRunning, "running", required), "Märker upp talare i den strömmade texten", "the flow labels by itself");
  assert.equal(runStage(audioRunning, "running", plain), "Förbereder den strömmade texten");
  assert.equal(runStage(audioRunning, "running", transcribed), "Transkriberar ljudet", "the request named no live transcript");
  assert.equal(runStage(audioRunning, "running", null), "Transkriberar ljudet", "a run opened later: not known");
  assert.equal(
    runStage(runSteps(graph("completed", "running"), { status: "running" }), "running", labelling),
    "Analysera mötesinnehållet",
    "the steps after it keep their own names",
  );
});

test("after a failure the failed step says Misslyckades and the steps that never started say Kördes inte", () => {
  // Eneo closes every pending step as failed when the run fails; started_at tells them apart.
  const failed = { status: "failed", error: { code: "flow_task_failure", message: "x", retryable: false, step_order: 2 } };
  const views = runSteps(graph("completed", "failed", "failed", "failed"), failed, [
    result(1, "completed", true),
    result(2, "failed", true),
    result(3, "failed", false),
    result(4, "failed", false),
  ]);

  assert.deepEqual(states(views), ["done", "failed", "not_run", "not_run"]);
  assert.deepEqual(views.map((view) => stepStateLabel(view.state)), ["Klar", "Misslyckades", "Kördes inte", "Kördes inte"]);
});

test("without the step results, the error's step still separates the failure from the steps after it", () => {
  const failed = { status: "failed", error: { code: "flow_task_failure", message: "x", retryable: false, step_order: 2 } };
  assert.deepEqual(states(runSteps(graph("completed", "failed", "failed", "failed"), failed)), [
    "done",
    "failed",
    "not_run",
    "not_run",
  ]);
});

test("a cancelled run: the interrupted step was cancelled, the rest did not run", () => {
  const views = runSteps(graph("completed", "cancelled", "cancelled", null), { status: "cancelled" }, [
    result(1, "completed", true),
    result(2, "cancelled", true),
    result(3, "cancelled", false),
  ]);
  assert.deepEqual(states(views), ["done", "cancelled", "not_run", "not_run"]);
  assert.equal(stepStateLabel("cancelled"), "Avbröts");
});

test("without a graph the step results alone still give order and state", () => {
  const views = runSteps(null, { status: "completed" }, [result(2, "completed", true), result(1, "completed", true)]);
  assert.deepEqual(views.map((view) => [view.order, view.label, view.state]), [
    [1, "Steg 1", "done"],
    [2, "Steg 2", "done"],
  ]);
});

test("run outcomes and statuses in words", () => {
  assert.equal(runOutcome("completed"), "succeeded");
  assert.equal(runOutcome("failed"), "failed");
  assert.equal(runOutcome("cancelled"), "cancelled");
  assert.equal(runOutcome("running"), null);
  assert.equal(runOutcome("awaiting_review"), null);
  assert.deepEqual(
    ["completed", "failed", "cancelled", "running", "queued", "awaiting_review"].map(runStatusLabel),
    ["Klar", "Misslyckades", "Avbröts", "Pågår", "Väntar på att starta", "Väntar på granskning"],
  );
});

test("an earlier run whose own graph could not be read keeps its own results, never today's steps", () => {
  // Republished since, so the flow's current steps have other ids than this run's results.
  const transcription = { segments: [{ start: 0, end: 2, text: "Välkomna.", speaker: null }] };
  const results: FlowRunStep[] = [
    { ...result(1, "completed", true), step_id: "old-1", input_payload_json: { transcription } },
    { ...result(2, "completed", true), step_id: "old-2" },
  ];

  const { steps, transcribed, stepLabels } = finishedRun(null, { status: "completed" }, results);

  assert.deepEqual(states(steps), ["done", "done"], "the run's own results, not today's steps as never run");
  assert.equal(transcribed, true, "its transcription step's result holds the transcript");
  assert.deepEqual(stepLabels, {}, "no names from another version");

  const plain = finishedRun(null, { status: "completed" }, [result(1, "completed", true)]);
  assert.equal(plain.transcribed, false, "a run whose results hold no transcript shows none");
});

test("a finished run names its steps by their order, the one key every run error carries", () => {
  const { stepLabels } = finishedRun(graph("completed", "failed", null, null), { status: "failed", error: { step_order: 2 } }, []);
  assert.deepEqual(stepLabels, {
    1: "Transkribera mötet",
    2: "Analysera mötesinnehållet",
    3: "Skriv sammanfattning",
    4: "Skapa rapport",
  });
});

test("a run that goes on says for how long, whole minutes from its start, and nothing in its first minute", () => {
  const start = "2026-09-25T10:00:00Z";
  const at = (minutes: number, seconds = 0) => Date.parse(start) + minutes * 60_000 + seconds * 1_000;
  assert.equal(runElapsed(start, at(0, 59)), null);
  assert.equal(runElapsed(start, at(1)), "Har pågått i 1 min");
  assert.equal(runElapsed(start, at(12, 59)), "Har pågått i 12 min");
  assert.equal(runElapsed(start, at(75)), "Har pågått i 1 h 15 min");
  assert.equal(runElapsed(undefined, at(5)), null, "a run whose start is not known yet");
  assert.equal(runElapsed(start, at(-3)), null, "a device clock behind Eneo's");
});
