import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import {
  deriveRunIdempotencyKey,
  isReviewCheckpointApproved,
  reviewResumeIdempotencyKey,
} from "./api";
import {
  baseMimetype,
  isMimeAllowed,
  isRuntimeFileInput,
  pickSupportedAudioMimetype,
  resolveRuntimeUploadIdleTimeoutMs,
  resolveRuntimeUploadInitialTimeoutMs,
  selectRuntimeInputStep,
} from "./upload";

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

test("runtime upload initial timeout is derived from policy and file size", () => {
  const timeoutMs = resolveRuntimeUploadInitialTimeoutMs(100 * 1024 * 1024, {
    min_timeout_seconds: 30,
    seconds_per_mebibyte: 3,
    max_timeout_seconds: 900,
    idle_timeout_seconds: 120,
  });

  assert.equal(timeoutMs, 300_000);
});

test("runtime upload initial timeout has a conservative size-based fallback", () => {
  assert.equal(resolveRuntimeUploadInitialTimeoutMs(1 * 1024 * 1024, null), 120_000);
  assert.equal(
    resolveRuntimeUploadInitialTimeoutMs(100 * 1024 * 1024, undefined),
    400_000,
  );
  assert.equal(
    resolveRuntimeUploadInitialTimeoutMs(900 * 1024 * 1024, undefined),
    1_800_000,
  );
});

test("runtime upload idle timeout falls back when policy is missing or invalid", () => {
  assert.equal(resolveRuntimeUploadIdleTimeoutMs(undefined), 120_000);
  assert.equal(
    resolveRuntimeUploadIdleTimeoutMs({
      min_timeout_seconds: 30,
      seconds_per_mebibyte: 3,
      max_timeout_seconds: 900,
      idle_timeout_seconds: 0,
    }),
    120_000,
  );
  assert.equal(
    resolveRuntimeUploadIdleTimeoutMs({
      min_timeout_seconds: 30,
      seconds_per_mebibyte: 3,
      max_timeout_seconds: 900,
      idle_timeout_seconds: 45,
    }),
    45_000,
  );
});

test("MIME helpers accept exact, base, and wildcard matches", () => {
  assert.equal(baseMimetype("audio/webm;codecs=opus"), "audio/webm");
  assert.equal(isMimeAllowed("audio/webm;codecs=opus", ["audio/webm"]), true);
  assert.equal(isMimeAllowed("audio/webm", ["audio/wav"]), false);
  assert.equal(isMimeAllowed("audio/webm", ["audio/*"]), true);
  assert.equal(isMimeAllowed("audio/webm", undefined), true);
  assert.equal(isMimeAllowed("audio/webm", []), true);
});

test("audio MIME picker never falls through to a preferred type that the flow disallows", () => {
  assert.equal(
    pickSupportedAudioMimetype(["audio/wav"], () => true),
    "audio/wav",
  );
  assert.equal(
    pickSupportedAudioMimetype(["audio/wav"], (mime) => mime === "audio/wav"),
    "audio/wav",
  );
  assert.equal(
    pickSupportedAudioMimetype(["audio/wav"], (mime) => mime.startsWith("audio/webm")),
    null,
  );
});

test("runtime input selection uses the first published file input by step order", () => {
  const contract = {
    flow_id: "flow",
    published_flow_version: 1,
    form_fields: [],
    steps_requiring_input: [
      { step_id: "document-step", step_order: 2, input_format: "document" },
      { step_id: "audio-step", step_order: 1, input_format: "audio" },
    ],
  };

  assert.equal(selectRuntimeInputStep(contract)?.step_id, "audio-step");
});

test("runtime input selection falls back to file inputs before arbitrary steps", () => {
  const contract = {
    flow_id: "flow",
    published_flow_version: 1,
    form_fields: [],
    steps_requiring_input: [
      { step_id: "text-step", input_format: "text" },
      { step_id: "file-step", input_format: "file" },
    ],
  };

  assert.equal(selectRuntimeInputStep(contract)?.step_id, "file-step");
});

test("runtime input format classification follows the run-contract upload formats", () => {
  assert.equal(isRuntimeFileInput("audio"), true);
  assert.equal(isRuntimeFileInput("document"), true);
  assert.equal(isRuntimeFileInput("file"), true);
  assert.equal(isRuntimeFileInput("text"), false);
  assert.equal(isRuntimeFileInput(undefined), false);
});

test("run idempotency key is deterministic across object key order", async () => {
  const first = await deriveRunIdempotencyKey({
    flowId: "flow",
    expectedFlowVersion: 1,
    body: {
      expected_flow_version: 1,
      step_inputs: { step: { file_ids: ["file"] } },
      input_payload_json: { b: "2", a: "1" },
    },
  });
  const second = await deriveRunIdempotencyKey({
    flowId: "flow",
    expectedFlowVersion: 1,
    body: {
      input_payload_json: { a: "1", b: "2" },
      step_inputs: { step: { file_ids: ["file"] } },
      expected_flow_version: 1,
    },
  });
  const changed = await deriveRunIdempotencyKey({
    flowId: "flow",
    expectedFlowVersion: 1,
    body: {
      expected_flow_version: 1,
      step_inputs: { step: { file_ids: ["other"] } },
      input_payload_json: { a: "1", b: "2" },
    },
  });

  assert.equal(first, second);
  assert.notEqual(first, changed);
});

test("review checkpoint helpers follow the approve/resume contract", () => {
  assert.equal(isReviewCheckpointApproved(null), false);
  assert.equal(
    isReviewCheckpointApproved({
      id: "checkpoint",
      flow_id: "flow",
      flow_run_id: "run",
      step_id: "step",
      step_order: 1,
      attempt_no: 1,
      state: "awaiting_review",
      revision: 1,
      schema_version: 1,
      created_at: "2026-05-29T10:00:00Z",
      updated_at: "2026-05-29T10:00:00Z",
    }),
    false,
  );
  assert.equal(
    isReviewCheckpointApproved({
      id: "checkpoint",
      flow_id: "flow",
      flow_run_id: "run",
      step_id: "step",
      step_order: 1,
      attempt_no: 1,
      state: "approved",
      revision: 2,
      schema_version: 1,
      created_at: "2026-05-29T10:00:00Z",
      updated_at: "2026-05-29T10:00:00Z",
    }),
    true,
  );
  assert.equal(
    reviewResumeIdempotencyKey("run-id", "checkpoint-id"),
    "review-resume:run-id:checkpoint-id",
  );
});
