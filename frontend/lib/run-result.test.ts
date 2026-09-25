import assert from "node:assert/strict";
import test from "node:test";

import type { FlowRunError, ResultFile } from "./api";
import { runErrorView, runOutput, runResultView } from "./run-result";

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

test("file-backed text shows its preview and says the whole text is in the file below it", () => {
  // The run's only file: it is the document's own file row, under the preview, and no Filer list is shown.
  const view = runResultView({
    kind: "file_backed_text",
    preview: "Mötet började klockan nio",
    file: transcriptFile("available"),
  });

  assert.equal(view.text, "Mötet började klockan nio");
  assert.match(view.note ?? "", /bara början/);
  assert.match(view.note ?? "", /Hela texten finns i filen nedanför\./);
  assert.doesNotMatch(view.note ?? "", /Filer/);
});

test("file-backed text whose file was purged does not point at the file", () => {
  const view = runResultView({
    kind: "file_backed_text",
    preview: "Mötet började klockan nio",
    file: transcriptFile("content_purged"),
  });

  assert.equal(view.text, "Mötet började klockan nio");
  assert.match(view.note ?? "", /bara början/);
  assert.doesNotMatch(view.note ?? "", /nedanför|Filer/);
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

test("retry advice follows Eneo's retryable flag, never the code", () => {
  const checkFirst =
    "Kontrollera vad som hann göras innan du kör flödet igen, eller kontakta support med körnings-ID.";
  // Eneo allows a new run only for flow_dispatch_failed,
  // flow_step_attempt_start_failed and flow_provider_rate_limited.
  for (const code of [
    "flow_worker_stalled",
    "flow_task_timeout",
    "flow_provider_unavailable",
    "flow_run_user_cancelled",
    "typed_io_transcription_failed",
    "flow_code_from_a_newer_eneo",
  ]) {
    const { summary } = runErrorView(runError({ code, retryable: false }));
    assert.ok(summary.endsWith(checkFirst), `${code}: ${summary}`);
    assert.doesNotMatch(summary.slice(0, -checkFirst.length), /\bigen\b/, code);
  }

  const { summary } = runErrorView(
    runError({ code: "flow_provider_rate_limited", retryable: true }),
  );
  assert.ok(summary.endsWith("Det går bra att köra flödet igen om en stund."), summary);
});

test("an input the flow cannot use says how to change it, and retry advice still follows retryable", () => {
  const checkFirst =
    "Kontrollera vad som hann göras innan du kör flödet igen, eller kontakta support med körnings-ID.";
  // typed_io_transcript_too_large can come after provider work (speaker
  // mapping), so the hint must not tell the user to run the flow again.
  const hints: Record<string, string> = {
    typed_io_audio_exceeds_limit: "Dela upp inspelningen eller filen i kortare delar.",
    typed_io_transcript_too_large: "Dela upp inspelningen eller filen i kortare delar.",
    typed_io_transcription_empty: "Inspelningen kan sakna tal.",
    typed_io_empty_extraction: "Filen behöver innehålla läsbar text.",
  };
  for (const [code, hint] of Object.entries(hints)) {
    const { summary, inputMustChange } = runErrorView(runError({ code, retryable: false }));
    assert.ok(summary.endsWith(`${hint} ${checkFirst}`), `${code}: ${summary}`);
    assert.doesNotMatch(summary.slice(0, -checkFirst.length), /\bkör\b|\bigen\b/, code);
    // The same audio cannot work, so the page offers no retry with it.
    assert.equal(inputMustChange, true, code);
  }
  assert.equal(runErrorView(runError({ code: "flow_task_timeout" })).inputMustChange, false);
});

test("the failed step is named from Eneo's description, else the flow graph", () => {
  assert.equal(
    runErrorView(
      runError({
        step_id: "step-2",
        step_order: 2,
        details: { step_description: "Sammanfatta mötet" },
      }),
      { 2: "Sammanfattning" },
    ).step,
    "Steg 2, Sammanfatta mötet",
  );
  assert.equal(
    runErrorView(runError({ step_id: "step-1", step_order: 1 }), { 1: "Transkribering" }).step,
    "Steg 1, Transkribering",
  );
  // Eneo's transcription limit names the step by its order only, as a real run reported it.
  assert.equal(
    runErrorView(runError({ code: "typed_io_audio_exceeds_limit", step_id: null, step_order: 1 }), { 1: "Transkribera ljud" }).step,
    "Steg 1, Transkribera ljud",
  );
  assert.equal(runErrorView(runError({ step_order: 3 })).step, "Steg 3");
  assert.equal(runErrorView(runError({})).step, null);
});

test("audio over the flow's limit is too long, not too large: Eneo's ceilings measure the decoded length", () => {
  const { summary } = runErrorView(runError({ code: "typed_io_audio_exceeds_limit" }));
  assert.match(summary, /^Inspelningen eller filen är längre än flödet klarar\./);
  assert.match(runErrorView(runError({ code: "typed_io_input_too_large" })).summary, /större än flödet klarar/);
});

test("a finished run says what it made in its own result; one without a result is read from its version's contract", () => {
  const contract = (delivery?: "payload" | "artifact" | "outbound_http") => ({
    published_flow_version: 3,
    final_output: { output_type: "text", delivery },
  });
  const done = (result: object, flow_version = 2) => ({ flow_version, result: result as never });
  // A finished run of an older version: its own result decides, whatever the flow is today.
  assert.equal(runOutput(done({ kind: "inline_text", text: "x" }), contract("artifact")), "text");
  assert.equal(runOutput(done({ kind: "file_backed_text", preview: "x", file: { file_id: "f" } }), null), "text");
  assert.equal(runOutput(done({ kind: "structured", value: {}, output_contract: null }), null), "text");
  assert.equal(runOutput(done({ kind: "artifact", files: [] }), contract("payload")), "document");
  assert.equal(runOutput(done({ kind: "outbound_http", delivery_status: "delivered" }), contract("payload")), null);
  // No result (failed, cancelled): the contract speaks only for its own version, and only as it states the delivery.
  const failed = (flow_version: number) => ({ flow_version, result: null });
  assert.equal(runOutput(failed(3), contract("payload")), "text");
  assert.equal(runOutput(failed(3), contract("artifact")), "document");
  assert.equal(runOutput(failed(3), contract("outbound_http")), null, "sent on: neither text nor a document");
  assert.equal(runOutput(failed(3), contract()), null, "no delivery stated");
  assert.equal(runOutput(failed(2), contract("payload")), null, "today's contract says nothing of an older version");
});
