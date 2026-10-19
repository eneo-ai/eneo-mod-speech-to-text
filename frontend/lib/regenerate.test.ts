import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { ApiError, type FlowRunPublic, type FlowRunStep, type TranscriptCorrectionsPublic } from "./api";
import { correctionsNewerThanDocument, namesOnly, regenerate, regenerationOffer, regenerationRefusal } from "./regenerate";
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
    message: "Transkriberingen eller rättningarna har ändrats sedan sidan lästes in. Läs in igen och försök sedan.",
    reload: true,
  });
  assert.match(refused(400, "flow_run_stale_version").message, /^Flödet har ändrats sedan dokumentet skapades/);
  assert.match(refused(400, "flow_transcript_corrections_invalid_occurrence").message, /kan inte skapa dokumentet igen från en rättad transkribering/);
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
  // What is seen: the other way each place can read is kept, inert and hidden, only for its size.
  const seenText = () => {
    const copy = view.container.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("[inert]").forEach((layer) => layer.remove());
    return copy.textContent ?? "";
  };
  assert.match(
    seenText(),
    /^Dokumentet skapades före dina ändringarDen nya versionen görs från den rättade transkriberingen och tar en stund\. Dokumentet som visas nu finns kvar under Tidigare körningar\.Skapa dokumentet igen$/,
    "a title, what the new version is and that this one stays, and the button",
  );
  // The design system's warning is an alert; this one is there when the page opens and is not announced.
  assert.ok(view.container.querySelector('[role="note"]'), "a note");
  assert.equal(view.container.querySelector('[role="alert"]'), null, "nothing is announced before a refusal");

  await view.act(async () => button(view.container, "Skapa dokumentet igen")!.click());
  assert.equal(started.length, 0);
  assert.match(view.container.querySelector('[role="alert"]')?.textContent ?? "", /har ändrats sedan sidan lästes in/);
  await view.act(async () => button(view.container, "Läs in igen")!.click());
  assert.equal(reloads, 1);

  answer = Response.json({ run: { id: "run-2", flow_id: "flow-1", status: "queued" }, created: true, source_run_id: "run-1", correction_revision: 2, first_regenerated_step_id: "s" }, { status: 201 });
  await view.act(async () => button(view.container, "Skapa dokumentet igen")!.click());
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

test("a save that only named speakers offers a new document like any other, under the key of its own revision", () => {
  const named: CorrectionSet = { ...saved, revision: 3, speakerNames: { SPEAKER_00: "Anna Berg" } };
  assert.deepEqual(regenerationOffer({ ...base, corrections: named }), {
    flowId: "flow-1", runId: "run-1", stepId: "step-1", runRevision: 4, correctionRevision: 3, segmentsHash: HASH,
  });
  assert.equal(namesOnly(named), true);
  assert.equal(namesOnly({ ...named, speaker_edits: [{ segment_index: 0, char_start: null, char_end: null, original: null, original_speaker: "SPEAKER_00", speaker: "SPEAKER_01" }] }), false);
  assert.equal(namesOnly(saved), false, "no names, nothing only named");
  // Read with the run, before the transcript: Eneo's own shape.
  assert.equal(namesOnly({ occurrences: [], speaker_edits: [], speaker_names: { SPEAKER_00: null } }), true);
});

test("Eneo's refusals for a transcript too long to make the document again from say so, and offer the download", () => {
  const refused = (code: string, context?: Record<string, unknown>) =>
    regenerationRefusal(new ApiError(400, "x", { code, context }, code));
  assert.deepEqual(refused("flow_transcript_corrections_invalid_occurrence", { reason: "file_backed_prefix_unsupported" }), {
    message: "Transkriberingen är för lång för att dokumentet ska kunna skapas igen här. Ladda ner den rättade transkriberingen i stället.",
    reload: false,
  });
  assert.deepEqual(refused("flow_run_input_payload_too_large", { max_inline_text_bytes: 1 }), {
    message: "Den rättade transkriberingen är större än flödet tar emot, så dokumentet kan inte skapas igen här. Ladda ner den rättade transkriberingen i stället.",
    reload: false,
  });
  assert.match(regenerationRefusal(new ApiError(400, "x", { context: { reason: "file_backed_prefix_unsupported" } }, "flow_transcript_corrections_invalid_occurrence"), "texten").message, /för att texten ska kunna/);
});

test("a notice for names alone says they show in the transcript already and the document gets them when it is made again", async () => {
  const { createElement } = await import("react");
  const { RegenerateNotice } = await import("../components/flow/RegenerateNotice");
  const shown = async (thing?: string) => {
    const view = await mount(
      createElement(RegenerateNotice, { offer: regenerationOffer(base)!, saveState: "idle", namesOnly: true, onStarted: () => undefined, onReload: () => undefined, thing }),
    );
    const copy = view.container.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("[inert]").forEach((layer) => layer.remove());
    await view.unmount();
    return copy.textContent ?? "";
  };
  assert.equal(
    await shown(),
    "Dokumentet skapades före dina ändringarNamnen syns redan i transkriberingen, och dokumentet får dem när du skapar det igen. Det som visas nu finns kvar under Tidigare körningar.Skapa dokumentet igen",
  );
  assert.match(await shown("texten"), /och texten får dem när du skapar den igen\. Den som visas nu finns kvar/);
});

test("whether saved corrections are newer than the document is known from the run's own read, before the transcript", () => {
  const steps = [
    { id: "r1", step_id: "step-1", step_order: 1, status: "completed", input_payload_json: { transcription: { text: "Hej." } } },
  ] as unknown as FlowRunStep[];
  const set = (updated_at: string | undefined, step_id = "step-1") => [{ step_id, updated_at }] as unknown as TranscriptCorrectionsPublic[];
  assert.equal(correctionsNewerThanDocument(run, steps, set("2026-09-24T10:00:00Z")), true);
  assert.equal(correctionsNewerThanDocument(run, steps, set("2026-09-24T09:00:00Z")), false, "older than the document");
  assert.equal(correctionsNewerThanDocument(run, steps, set("2026-09-24T10:00:00Z", "another-step")), false, "another step's");
  assert.equal(correctionsNewerThanDocument(run, steps, set(undefined)), false, "nothing saved");
  assert.equal(correctionsNewerThanDocument(run, steps, null), false, "the read failed: the transcript decides, as before");
});

test("the notice stands while the transcript is read, its button waiting, and says in the same places if the corrections cannot make a new document", async () => {
  const { createElement } = await import("react");
  const { RegenerateNotice } = await import("../components/flow/RegenerateNotice");
  const props = { offer: null, saveState: "idle" as const, onStarted: () => undefined, onReload: () => undefined };
  // What is seen: what no inert layer holds (the other way the same place reads is kept, hidden, for its size).
  const seen = (element: Element | null | undefined) => Boolean(element) && !element!.closest("[inert]");
  const words = (container: HTMLElement, text: string) => [...container.querySelectorAll("span")].find((span) => span.textContent === text);

  const reading = await mount(createElement(RegenerateNotice, { ...props, reading: true }));
  const make = button(reading.container, "Skapa dokumentet igen")!;
  assert.ok(seen(make) && make.disabled, "waits for the transcript");
  assert.ok(seen(words(reading.container, "Den nya versionen görs från den rättade transkriberingen och tar en stund. Dokumentet som visas nu finns kvar under Tidigare körningar.")));
  assert.ok(!seen(button(reading.container, "Läs in igen")));
  await reading.unmount();

  let reloads = 0;
  const settled = await mount(createElement(RegenerateNotice, { ...props, onReload: () => void reloads++ }));
  assert.ok(seen(words(settled.container, "Rättningarna kunde inte läsas just nu.")), "in the description's place");
  assert.ok(!seen(words(settled.container, "Den nya versionen görs från den rättade transkriberingen och tar en stund. Dokumentet som visas nu finns kvar under Tidigare körningar.")));
  assert.ok(!seen(button(settled.container, "Skapa dokumentet igen")));
  const again = button(settled.container, "Läs in igen")!;
  assert.ok(seen(again), "in the button's place");
  await settled.act(async () => again.click());
  assert.equal(reloads, 1);
});
