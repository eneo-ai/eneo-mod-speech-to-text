import assert from "node:assert/strict";
import test from "node:test";

import type { RunContract } from "./api";
import { howItWorks } from "./flow-output";
import { availableModes } from "./flow-session";

const speakerReview = {
  review_mode: "edit",
  output_type: "json",
  output_contract: { properties: { speakers: { items: { properties: { label: { pattern: "^SPEAKER_\\d{2,}$" } } } } } },
} as unknown as NonNullable<RunContract["steps_requiring_review"]>[number];

type Device = Parameters<typeof availableModes>[1];
const RECORDS_AND_STREAMS: Device = { canRecord: true, liveClient: true };
const RECORDS: Device = { canRecord: true, liveClient: false };
const UPLOAD_ONLY: Device = { canRecord: false, liveClient: false };

const contract = (overrides: Partial<RunContract> = {}, input: Record<string, unknown> = {}): RunContract =>
  ({
    flow_id: "flow-1",
    published_flow_version: 1,
    transcription: { live: { available: true } },
    steps_requiring_input: [{ step_id: "step-1", input_format: "audio", required: true, ...input }],
    final_output: { output_type: "docx", delivery: "artifact" },
    ...overrides,
  }) as RunContract;

/** The guide a person on this device gets from this contract: the ways in come from the same place the setup's do. */
const guide = (flow: RunContract, device: Device) => howItWorks(flow, availableModes(flow, device));

test("a recorded or uploaded meeting that ends in a file says each step the person meets, in order", () => {
  const flow = contract({ steps_requiring_review: [speakerReview] });
  assert.deepEqual(guide(flow, RECORDS_AND_STREAMS)?.steps, [
    "Du spelar in eller laddar upp ljud.",
    "Ljudet görs om till text.",
    "Du bekräftar vem som är vem.",
    "Du får ett dokument att ladda ner.",
  ]);
});

test("the way in names only the ways the device has", () => {
  assert.equal(guide(contract(), RECORDS)?.steps[0], "Du spelar in eller laddar upp ljud.");
  assert.equal(guide(contract(), UPLOAD_ONLY)?.steps[0], "Du laddar upp en ljudfil.");
});

test("audio the flow can run without is offered, not asked for", () => {
  const optional = contract({}, { required: false });
  assert.equal(guide(optional, RECORDS)?.steps[0], "Du kan spela in eller ladda upp ljud.");
  assert.equal(guide(optional, UPLOAD_ONLY)?.steps[0], "Du kan ladda upp en ljudfil.");
});

test("a flow that takes a document, or no file, has no account of audio", () => {
  assert.equal(guide(contract({}, { input_format: "document" }), RECORDS), null);
  assert.equal(guide(contract({ steps_requiring_input: [] }), RECORDS), null);
});

test("the last line follows how the result is delivered, never what the flow makes", () => {
  const last = (delivery: "payload" | "artifact" | "outbound_http" | null | undefined) =>
    guide(contract({ final_output: { output_type: "text", delivery } }), UPLOAD_ONLY)?.steps.at(-1);
  assert.equal(last("payload"), "Du får texten att läsa och kopiera.");
  assert.equal(last("artifact"), "Du får ett dokument att ladda ner.");
  assert.equal(last("outbound_http"), "Resultatet skickas vidare till en mottagare.");
  assert.equal(last(null), "Du får resultatet här när flödet är klart.");
  assert.equal(last(undefined), "Du får resultatet här när flödet är klart.");
});

test("a flow that does not transcribe and one without speaker review do not claim those steps", () => {
  assert.deepEqual(guide(contract({ transcription: null }), UPLOAD_ONLY)?.steps, [
    "Du laddar upp en ljudfil.",
    "Du får ett dokument att ladda ner.",
  ]);
});

test("tips are for recording, and the one about names helps the naming without promising it", () => {
  assert.deepEqual(guide(contract(), UPLOAD_ONLY)?.tips, []);
  assert.deepEqual(guide(contract(), RECORDS)?.tips, ["Ställ en enhet mitt på bordet.", "Stäng dörrar och fönster om du kan."]);
  assert.deepEqual(guide(contract({ steps_requiring_review: [speakerReview] }), RECORDS_AND_STREAMS)?.tips, [
    "Be alla säga sitt namn i början. Det hjälper när du bekräftar vem som är vem.",
    "Ställ en enhet mitt på bordet.",
    "Stäng dörrar och fönster om du kan.",
  ]);
});
