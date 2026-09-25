import assert from "node:assert/strict";
import test from "node:test";

import type { FlowRunReviewCheckpointPublic } from "./api";
import { clearDraft, unstoredDrafts, writeDraft, type DraftStorage } from "./drafts";
import { continueFromPause, DECIDED } from "./review-continue";
import { buildEditedMapping, buildSpeakerRows } from "./speaker-mapping";

const PAUSE = "/api/eneo/flows/flow-1/runs/run-1/review-checkpoints/cp-1/";

/**
 * Eneo's review pause as its checkpoint repository keeps it: an edit needs the current revision and an
 * active pause, approving moves it on a revision and takes no more edits, and resume fails `resumeFailures`
 * times before it goes through. `lost` drops the answer to the named request after Eneo has acted on it.
 */
function eneo(t: { after: (fn: () => void) => void }, { resumeFailures = 1, lost = "" } = {}) {
  let pause = {
    id: "cp-1",
    flow_id: "flow-1",
    flow_run_id: "run-1",
    step_id: "step-2",
    step_order: 2,
    attempt_no: 1,
    schema_version: 1,
    state: "awaiting_review",
    revision: 1,
    review_mode: "edit",
    output_type: "json",
    created_at: "2026-09-24T09:00:00Z",
    updated_at: "2026-09-24T09:00:00Z",
    current_payload_json: {
      speaker_mapping: { inventory: [{ label: "SPEAKER_00", line_count: 3 }, { label: "SPEAKER_01", line_count: 2 }] },
      structured: { speakers: [{ label: "SPEAKER_00", name: "Anna Berg", confidence: "high", evidence: "Hälsar välkommen." }] },
    },
  } as FlowRunReviewCheckpointPublic;
  let runStatus = "awaiting_review";
  const calls: string[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const path = new URL(String(url), "http://module.test").pathname;
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const answer = (name: string, response: Response) => {
      calls.push(name);
      if (lost === name) throw new TypeError("Failed to fetch");
      return response;
    };
    if (method === "PATCH" && path === PAUSE) {
      if (pause.state !== "awaiting_review") return answer("edit", json(409, { code: "flow_review_not_active" }));
      if (body.expected_checkpoint_revision !== pause.revision) return answer("edit", json(409, { code: "flow_review_stale_revision" }));
      pause = { ...pause, revision: pause.revision + 1, current_payload_json: { ...(pause.current_payload_json as object), structured: body.edited_value } };
      return answer("edit", json(200, pause));
    }
    if (method === "POST" && path === `${PAUSE}approve/`) {
      if (pause.state !== "awaiting_review") return answer("approve", json(409, { code: "flow_review_not_active" }));
      if (body.expected_checkpoint_revision !== pause.revision) return answer("approve", json(409, { code: "flow_review_stale_revision" }));
      pause = { ...pause, state: "approved", revision: pause.revision + 1 };
      return answer("approve", json(200, pause));
    }
    if (method === "POST" && path === `${PAUSE}resume/`) {
      if (pause.state !== "approved") return answer("resume", json(409, { code: "flow_review_not_approved" }));
      if (resumeFailures-- > 0) return answer("resume", json(503, { code: "upstream_unreachable" }));
      pause = { ...pause, state: "resumed", revision: pause.revision + 1 };
      runStatus = "running";
      return answer("resume", json(200, { checkpoint: pause, run: { id: "run-1", flow_id: "flow-1", status: runStatus } }));
    }
    if (path === "/api/eneo/flows/flow-1/runs/run-1/review-checkpoints/active/") {
      return json(200, pause.state === "resumed" ? null : pause);
    }
    if (path === "/api/eneo/flows/flow-1/runs/run-1/") return json(200, { id: "run-1", flow_id: "flow-1", status: runStatus });
    return json(404, { detail: `stub: ${method} ${path}` });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return { calls, pause: () => pause };
}

const named = (payload: unknown, name: string) =>
  buildEditedMapping(
    buildSpeakerRows(payload as never).map((row) => (row.label === "SPEAKER_01" ? { ...row, name } : row)),
  );

test("Spara och fortsätt after a resume that failed only resumes: the names were saved and the pause approved", async (t) => {
  const server = eneo(t);
  let held = server.pause();
  const edit = named(held.current_payload_json, "Erik Lund");
  const go = () => continueFromPause({ flowId: "flow-1", runId: "run-1", checkpoint: held, edit, onCheckpoint: (cp) => (held = cp) });

  await assert.rejects(go(), "the first resume fails");
  assert.deepEqual(server.calls, ["edit", "approve", "resume"]);
  assert.equal(held.state, "approved", "the page now holds the approved pause");

  const run = await go();
  assert.equal(run.status, "running");
  assert.deepEqual(server.calls, ["edit", "approve", "resume", "resume"], "no second save and no second approval");
  assert.deepEqual(
    (server.pause().current_payload_json as { structured: unknown }).structured,
    edit,
    "the names are the ones saved the first time",
  );
});

test("a pause approved behind the page's back (its revision stale here) is read back, then only resumed", async (t) => {
  const server = eneo(t, { lost: "approve" });
  let held = server.pause();
  const edit = named(held.current_payload_json, "Erik Lund");
  const go = () => continueFromPause({ flowId: "flow-1", runId: "run-1", checkpoint: held, edit, onCheckpoint: (cp) => (held = cp) });

  // The approval went through, but its answer was lost; the resume then fails.
  await assert.rejects(go());
  assert.deepEqual(server.calls, ["edit", "approve", "resume"]);
  assert.equal(held.state, "approved", "read back from Eneo");

  // Again with the pause as it was before the approval (a stale revision): nothing is saved or approved again.
  held = { ...held, state: "awaiting_review", revision: held.revision - 1 };
  const run = await go();
  assert.equal(run.status, "running");
  assert.deepEqual(server.calls.slice(3), ["approve", "resume"], "the refused approval is read back as approved, then resumed");
});

test("names the pause already holds are not saved again; changed names are, while the pause takes edits", async (t) => {
  const server = eneo(t, { resumeFailures: 0 });
  const held = server.pause();
  await continueFromPause({
    flowId: "flow-1",
    runId: "run-1",
    checkpoint: held,
    edit: buildEditedMapping(buildSpeakerRows(held.current_payload_json as never)),
    onCheckpoint: () => undefined,
  });
  assert.deepEqual(server.calls, ["approve", "resume"], "nothing new to save");
});

test("an approved pause does not take a changed name: continuing with it is refused, never resumed with the old one", async (t) => {
  const server = eneo(t);
  let held = server.pause();
  const go = (edit: unknown) =>
    continueFromPause({ flowId: "flow-1", runId: "run-1", checkpoint: held, edit: edit as never, onCheckpoint: (cp) => (held = cp) });

  await assert.rejects(go(named(held.current_payload_json, "Erik Lund")), "saved Erik, approved, the resume failed");
  assert.equal(held.state, "approved");

  // Erik changed to Sara after the approval, and Spara och fortsätt again.
  await assert.rejects(go(named(held.current_payload_json, "Sara Holm")), (err: Error) => err.message === DECIDED);
  assert.deepEqual(server.calls, ["edit", "approve", "resume"], "neither saved nor resumed");
  assert.equal(
    (server.pause().current_payload_json as { structured: { speakers: { label: string; name: string }[] } }).structured.speakers.find(
      (speaker) => speaker.label === "SPEAKER_01",
    )?.name,
    "Erik Lund",
  );
});

test("a kept draft goes once Eneo holds its content: unchanged names, and an approved retry, leave nothing unkept", async (t) => {
  // A browser that refuses to keep drafts: the page alone holds them, and leaving would ask.
  const refusing: DraftStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => undefined,
    key: () => null,
    length: 0,
  };
  t.after(() => unstoredDrafts.forget());
  const server = eneo(t);
  let held = server.pause();
  const keepAndGo = (name: string) => {
    const edit = named(held.current_payload_json, name);
    writeDraft(refusing, "user-1", "review:run-1:cp-1", edit);
    return continueFromPause({
      flowId: "flow-1",
      runId: "run-1",
      checkpoint: held,
      edit,
      onCheckpoint: (cp) => (held = cp),
      onHeld: () => clearDraft(refusing, "user-1", "review:run-1:cp-1"),
    });
  };

  await assert.rejects(keepAndGo("Erik Lund"), "saved and approved, the resume failed");
  assert.equal(unstoredDrafts.any(), false, "saved: the draft went");

  const run = await keepAndGo("Erik Lund");
  assert.equal(run.status, "running");
  assert.deepEqual(server.calls, ["edit", "approve", "resume", "resume"]);
  assert.equal(unstoredDrafts.any(), false, "the approved retry held the same names: nothing left for a leave question");
});

test("unchanged names on an open pause: approved and resumed without a save, and their draft goes", async (t) => {
  t.after(() => unstoredDrafts.forget());
  const server = eneo(t, { resumeFailures: 0 });
  const held = server.pause();
  const edit = buildEditedMapping(buildSpeakerRows(held.current_payload_json as never));
  const refused: DraftStorage = { getItem: () => null, setItem: () => { throw new Error("full"); }, removeItem: () => undefined, key: () => null, length: 0 };
  writeDraft(refused, "user-1", "review:run-1:cp-1", edit);
  assert.equal(unstoredDrafts.any(), true);
  await continueFromPause({
    flowId: "flow-1",
    runId: "run-1",
    checkpoint: held,
    edit,
    onCheckpoint: () => undefined,
    onHeld: () => clearDraft(refused, "user-1", "review:run-1:cp-1"),
  });
  assert.deepEqual(server.calls, ["approve", "resume"]);
  assert.equal(unstoredDrafts.any(), false, "the running view has no leave question to answer");
});

