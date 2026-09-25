import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { ApiError, type FlowRunPublic } from "./api";
import { regenerate, regenerationOffer, regenerationRefusal } from "./regenerate";
import { button, cleanup, installDom, mount } from "./test-dom";
import type { CorrectionSet } from "./transcript-corrections";

installDom();
afterEach(cleanup);

const HASH = "a".repeat(64);
const run: FlowRunPublic = {
  id: "run-1",
  flow_id: "flow-1",
  status: "completed",
  revision: 4,
  finished_at: "2026-09-24T09:02:00Z",
} as FlowRunPublic;
const saved: CorrectionSet = {
  schemaVersion: 3,
  segmentsHash: HASH,
  occurrences: [],
  speaker_edits: [],
  revision: 2,
  updatedAt: "2026-09-24T10:00:00Z",
};
const base = { flowId: "flow-1", run, stepId: "step-1", fromMetadata: true, corrections: saved, hasDocument: true };

test("a new document is offered only for corrections saved after the document, on a stored transcript", () => {
  assert.deepEqual(regenerationOffer(base), {
    flowId: "flow-1", runId: "run-1", stepId: "step-1", runRevision: 4, correctionRevision: 2, segmentsHash: HASH,
  });
  // Corrections from before the document was made change nothing in it.
  assert.equal(regenerationOffer({ ...base, corrections: { ...saved, updatedAt: "2026-09-24T09:00:00Z" } }), null);
  // Nothing saved yet.
  assert.equal(regenerationOffer({ ...base, corrections: { ...saved, revision: null, updatedAt: undefined } }), null);
  // A text-only transcript (no stored segments), as Pianissimo gives today: its corrections cannot be saved either.
  assert.equal(regenerationOffer({ ...base, fromMetadata: false }), null);
  // Without Eneo's source hash the request could not name what it was made from.
  assert.equal(regenerationOffer({ ...base, corrections: { ...saved, schemaVersion: 2, segmentsHash: null } }), null);
  // No document to make again.
  assert.equal(regenerationOffer({ ...base, hasDocument: false }), null);
});

test("the request names the run, the corrections and the source, under a key that repeats the same run", async (t) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  t.after(() => void (globalThis.fetch = original));
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json({ run: { id: "run-2", flow_id: "flow-1", status: "queued" }, created: true, source_run_id: "run-1", correction_revision: 2, first_regenerated_step_id: "step-2" }, { status: 201 });
  }) as typeof fetch;

  const outcome = await regenerate(regenerationOffer(base)!);
  assert.deepEqual(outcome, { kind: "started", run: { id: "run-2", flow_id: "flow-1", status: "queued" } });
  assert.equal(calls[0].url, "/api/eneo/flows/flow-1/runs/run-1/steps/step-1/transcript-regenerations/");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { expected_run_revision: 4, expected_correction_revision: 2, segments_hash: HASH });
  assert.equal(new Headers(calls[0].init.headers).get("Idempotency-Key"), "transcript-regeneration:run-1:2");
});

test("Eneo's refusals say what happened in Swedish, and which ones reading the page again solves", () => {
  const refused = (status: number, code: string) => regenerationRefusal(new ApiError(status, "x", null, code));
  assert.deepEqual(refused(400, "flow_transcript_corrections_stale_revision"), {
    message: "Transkriptet eller rättningarna har ändrats sedan sidan lästes in. Läs in igen och försök sedan.",
    reload: true,
  });
  assert.match(refused(400, "flow_run_stale_version").message, /^Flödet har ändrats sedan dokumentet skapades/);
  assert.match(refused(400, "flow_transcript_corrections_invalid_occurrence").message, /kan inte skapa dokumentet igen från ett rättat transkript/);
  assert.match(refused(403, "flow_run_access_denied").message, /behörighet att skapa dokumentet igen/);
  assert.deepEqual(refused(429, "flow_run_concurrency_limit_reached"), {
    message: "För många körningar pågår just nu. Försök igen om en stund.",
    reload: false,
  });
  for (const code of ["flow_run_stale_version", "flow_transcript_corrections_invalid_occurrence", "flow_run_access_denied"]) {
    assert.equal(refused(400, code).reload, false, code);
    // A flow that makes text is refused in the same words about the text.
    const text = regenerationRefusal(new ApiError(400, "x", null, code), "texten").message;
    assert.match(text, /texten/, code);
    assert.doesNotMatch(text, /dokument/, code);
  }
});

test("the notice starts the new run only when asked, and shows a refusal with the way on", async (t) => {
  const { createElement } = await import("react");
  const { RegenerateNotice } = await import("../components/flow/RegenerateNotice");
  const original = globalThis.fetch;
  t.after(() => void (globalThis.fetch = original));
  let answer: Response = Response.json({ code: "flow_transcript_corrections_stale_revision", message: "stale" }, { status: 400 });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return answer.clone();
  }) as typeof fetch;
  const started: string[] = [];
  let reloads = 0;
  const view = await mount(
    createElement(RegenerateNotice, {
      offer: regenerationOffer(base)!,
      saveState: "idle",
      onStarted: (next: FlowRunPublic) => started.push(next.id),
      onReload: () => void reloads++,
    }),
  );
  assert.equal(calls, 0, "never on its own");
  assert.match(
    view.container.textContent ?? "",
    /^Dokumentet skapades före dina rättningarDen nya versionen görs från det rättade transkriptet\.Skapa dokumentet igen med rättningarna$/,
    "a title, one short line and the button",
  );

  await view.act(async () => button(view.container, "Skapa dokumentet igen med rättningarna")!.click());
  assert.equal(started.length, 0);
  assert.match(view.container.querySelector('[role="alert"]')?.textContent ?? "", /har ändrats sedan sidan lästes in/);
  await view.act(async () => button(view.container, "Läs in igen")!.click());
  assert.equal(reloads, 1);

  answer = Response.json({ run: { id: "run-2", flow_id: "flow-1", status: "queued" }, created: true, source_run_id: "run-1", correction_revision: 2, first_regenerated_step_id: "s" }, { status: 201 });
  await view.act(async () => button(view.container, "Skapa dokumentet igen med rättningarna")!.click());
  assert.deepEqual(started, ["run-2"]);
});

test("while corrections are being saved, the new document waits for them", async () => {
  const { createElement } = await import("react");
  const { RegenerateNotice } = await import("../components/flow/RegenerateNotice");
  const view = await mount(
    createElement(RegenerateNotice, { offer: regenerationOffer(base)!, saveState: "saving", onStarted: () => undefined, onReload: () => undefined }),
  );
  assert.equal(button(view.container, "Sparar rättningarna…")!.disabled, true);
});
