import assert from "node:assert/strict";
import test from "node:test";

import type { FlowRunError, ResultFile } from "./api";
import { runErrorView, runResultView } from "./run-result";

const transcriptFile = (availability: string): ResultFile => ({
  file_id: "file-1",
  name: "transkript.txt",
  availability,
});

const runError = (overrides: Partial<FlowRunError>): FlowRunError => ({
  code: "flow_task_failure",
  message: "Flow execution failed.",
  retryable: false,
  ...overrides,
});

test("inline text is the complete result", () => {
  assert.deepEqual(
    runResultView({ kind: "inline_text", text: "## Protokoll\nMötet började." }),
    { text: "## Protokoll\nMötet började.", note: null },
  );
});

test("file-backed text shows its preview and says the whole text is in the file", () => {
  const view = runResultView({
    kind: "file_backed_text",
    preview: "Mötet började klockan nio",
    file: transcriptFile("available"),
  });

  assert.equal(view.text, "Mötet började klockan nio");
  assert.match(view.note ?? "", /bara början/);
  assert.match(view.note ?? "", /Genererade filer/);
});

test("file-backed text whose file was purged does not point at the file", () => {
  const view = runResultView({
    kind: "file_backed_text",
    preview: "Mötet började klockan nio",
    file: transcriptFile("content_purged"),
  });

  assert.equal(view.text, "Mötet började klockan nio");
  assert.match(view.note ?? "", /bara början/);
  assert.doesNotMatch(view.note ?? "", /Genererade filer/);
});

test("a structured value renders as text when it is a string, otherwise as JSON", () => {
  assert.deepEqual(
    runResultView({ kind: "structured", value: "Kort svar", output_contract: null }),
    { text: "Kort svar", note: null },
  );
  assert.deepEqual(
    runResultView({
      kind: "structured",
      value: { beslut: "bifall" },
      output_contract: null,
    }),
    { text: '```json\n{\n  "beslut": "bifall"\n}\n```', note: null },
  );
});

test("artifacts have no text, outbound delivery says where the result went", () => {
  assert.deepEqual(
    runResultView({ kind: "artifact", files: [transcriptFile("available")] }),
    { text: null, note: null },
  );
  const delivered = runResultView({
    kind: "outbound_http",
    delivery_status: "delivered",
  });
  assert.equal(delivered.text, null);
  assert.match(delivered.note ?? "", /skickades vidare/);
  assert.deepEqual(runResultView(null), { text: null, note: null });
});

test("a run error is described by its code, never by its message", () => {
  const view = runErrorView(
    runError({
      code: "typed_io_transcription_empty",
      message: "Step 1: the model returned no text for 'möte.webm'.",
      step_order: 1,
    }),
  );

  assert.match(view.summary, /Transkriberingen gav ingen text/);
  assert.doesNotMatch(view.summary, /möte\.webm/);
  // The message stays available as Eneo's technical detail.
  assert.equal(view.detail, "Step 1: the model returned no text for 'möte.webm'.");
});

test("an unknown code falls back on whether Eneo allows a new run", () => {
  const retryable = runErrorView(
    runError({ code: "flow_code_from_a_newer_eneo", retryable: true }),
  );
  const final = runErrorView(
    runError({ code: "flow_code_from_a_newer_eneo", retryable: false }),
  );

  assert.match(retryable.summary, /Försök igen/);
  assert.match(final.summary, /körnings-ID/);
  assert.notEqual(retryable.summary, final.summary);
});

test("the failed step is named from Eneo's description, else the flow graph", () => {
  assert.equal(
    runErrorView(
      runError({
        step_id: "step-2",
        step_order: 2,
        details: { step_description: "Sammanfatta mötet" },
      }),
      { "step-2": "Sammanfattning" },
    ).step,
    "Steg 2 · Sammanfatta mötet",
  );
  assert.equal(
    runErrorView(runError({ step_id: "step-1", step_order: 1 }), {
      "step-1": "Transkribering",
    }).step,
    "Steg 1 · Transkribering",
  );
  assert.equal(runErrorView(runError({ step_order: 3 })).step, "Steg 3");
  assert.equal(runErrorView(runError({})).step, null);
});
