import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalQuestion,
  buildEditedMapping,
  buildSpeakerRows,
  getSpeakerMappingInferNames,
  getSpeakerMappingParticipants,
  isSpeakerMappingCheckpoint,
  sameNameAs,
  speakerNamesFromRows,
  unmappedSpeakerLabels,
  unnamedNote,
} from "./speaker-mapping";
import { isSpeakerMappingReviewStep } from "./api";

// The shape Eneo writes into the checkpoint's current_payload_json for a speaker-mapping step
// (see eneo: flows/runtime/step_handlers/speaker_mapping.py).
const payload = {
  text: "[00:00:00 - 00:00:04] Anna: Hej.\n[00:00:05 - 00:00:09] SPEAKER_01: Hallå.",
  structured: {
    speakers: [
      { label: "SPEAKER_00", name: "Anna", confidence: "high", evidence: "Presenterar sig." },
      { label: "SPEAKER_01", name: null, confidence: "low", evidence: "" },
    ],
  },
  speaker_mapping: {
    source_step_id: "step-1",
    source_step_order: 1,
    source_attempt_no: 1,
    participants_field: "deltagare",
    participants: ["Anna", "Bo"],
    infer_names: false,
    inventory: [
      { label: "SPEAKER_00", file_index: 0, file_id: null, line_count: 1, samples: ["Hej."] },
      { label: "SPEAKER_01", file_index: 0, file_id: null, line_count: 1, samples: ["Hallå."] },
    ],
  },
};

test("speaker mapping checkpoint is detected by the speaker_mapping payload key", () => {
  assert.equal(isSpeakerMappingCheckpoint(payload), true);
  assert.equal(isSpeakerMappingCheckpoint({ text: "x" }), false);
  assert.equal(isSpeakerMappingCheckpoint(null), false);
  assert.equal(isSpeakerMappingCheckpoint({ speaker_mapping: [] }), false);
});

test("participants and infer_names are read from the extension", () => {
  assert.deepEqual(getSpeakerMappingParticipants(payload), ["Anna", "Bo"]);
  assert.equal(getSpeakerMappingInferNames(payload), false);
  assert.deepEqual(getSpeakerMappingParticipants({ text: "x" }), []);
});

test("rows follow the inventory order and merge in the proposals", () => {
  const rows = buildSpeakerRows(payload);
  assert.deepEqual(rows, [
    {
      label: "SPEAKER_00",
      lineCount: 1,
      samples: ["Hej."],
      name: "Anna",
      confidence: "high",
      evidence: "Presenterar sig.",
    },
    {
      label: "SPEAKER_01",
      lineCount: 1,
      samples: ["Hallå."],
      name: null,
      confidence: "low",
      evidence: "",
    },
  ]);
});

test("unknown confidence values are coerced to low and blank names to null", () => {
  const rows = buildSpeakerRows({
    structured: { speakers: [{ label: "SPEAKER_00", name: "   ", confidence: "certain" }] },
    speaker_mapping: { inventory: [{ label: "SPEAKER_00", line_count: 3 }] },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, null);
  assert.equal(rows[0].confidence, "low");
  assert.deepEqual(rows[0].samples, []);
});

test("edited value contains every inventory label exactly once with trimmed names", () => {
  const rows = buildSpeakerRows(payload);
  rows[1] = { ...rows[1], name: "  Bo " };
  assert.deepEqual(buildEditedMapping(rows), {
    speakers: [
      { label: "SPEAKER_00", name: "Anna", confidence: "high", evidence: "Presenterar sig." },
      { label: "SPEAKER_01", name: "Bo", confidence: "low", evidence: "" },
    ],
  });
});

test("the names of the rows, and the labels still without one", () => {
  const rows = buildSpeakerRows(payload);
  rows[1] = { ...rows[1], name: "Cecilia" };
  assert.deepEqual(speakerNamesFromRows(rows), {
    SPEAKER_00: "Anna",
    SPEAKER_01: "Cecilia",
  });
  assert.deepEqual(unmappedSpeakerLabels(buildSpeakerRows(payload)), ["SPEAKER_01"]);
});

test("a speaker-mapping review step is recognised from the run contract", () => {
  const speakerStep = {
    step_id: "s2",
    step_order: 2,
    review_mode: "edit",
    output_type: "json",
    expires_after_seconds: 3600,
    output_contract: {
      type: "object",
      required: ["speakers"],
      properties: {
        speakers: {
          type: "array",
          items: {
            type: "object",
            required: ["label", "name", "confidence"],
            properties: {
              label: { type: "string", pattern: "^SPEAKER_\\d{2,}$" },
              name: { type: ["string", "null"] },
              confidence: { enum: ["low", "medium", "high"] },
              evidence: { type: "string" },
            },
          },
        },
      },
    },
  };
  assert.equal(isSpeakerMappingReviewStep(speakerStep), true);
  assert.equal(
    isSpeakerMappingReviewStep({
      step_id: "s3",
      step_order: 3,
      review_mode: "edit",
      output_type: "text",
      expires_after_seconds: 3600,
    }),
    false,
  );
  assert.equal(
    isSpeakerMappingReviewStep({
      step_id: "s4",
      step_order: 4,
      review_mode: "edit",
      output_type: "json",
      expires_after_seconds: 3600,
      output_contract: { type: "object", properties: { summary: { type: "string" } } },
    }),
    false,
  );
});

test("the speakers' card says how many of all have no name, and which", () => {
  assert.equal(unnamedNote([], 6), null);
  assert.equal(unnamedNote(["SPEAKER_03"], 6), "1 av 6 talare saknar namn: Talare 4. Talaren behåller sin etikett i transkriberingen.");
  assert.equal(
    unnamedNote(["SPEAKER_03", "SPEAKER_05"], 6),
    "2 av 6 talare saknar namn: Talare 4, Talare 6. De behåller sin etikett i transkriberingen.",
  );
});

test("Godkänn asks about speakers without a name and names typed but not saved, and about nothing else", () => {
  assert.equal(approvalQuestion([], false), null, "nothing unresolved: no question");
  assert.deepEqual(approvalQuestion(["SPEAKER_03"], false), ["Talare 4 saknar namn och står kvar som etikett i dokumentet."]);
  assert.deepEqual(approvalQuestion(["SPEAKER_03", "SPEAKER_05"], false), [
    "2 talare saknar namn: Talare 4 och Talare 6. De står kvar som etiketter i dokumentet.",
  ]);
  assert.deepEqual(approvalQuestion(["SPEAKER_00", "SPEAKER_01", "SPEAKER_02"], true), [
    "3 talare saknar namn: Talare 1, Talare 2 och Talare 3. De står kvar som etiketter i dokumentet.",
    "Namnen du skrev i Namnge talarna är inte sparade och kommer inte med om du godkänner nu.",
  ]);
  assert.deepEqual(approvalQuestion([], true), ["Namnen du skrev i Namnge talarna är inte sparade och kommer inte med om du godkänner nu."]);
});

test("a name another speaker has is found as a reader would: case and spaces aside, never the row itself or an empty name", () => {
  const row = (label: string, name: string | null) => ({ label, lineCount: 1, samples: [], name, confidence: "high" as const, evidence: "" });
  const rows = [row("SPEAKER_00", "Anna Berg"), row("SPEAKER_01", null), row("SPEAKER_02", "  anna   berg ")];
  assert.equal(sameNameAs(rows, "SPEAKER_02", "  anna   berg "), "SPEAKER_00");
  assert.equal(sameNameAs(rows, "SPEAKER_00", "Anna Berg"), "SPEAKER_02");
  assert.equal(sameNameAs(rows, "SPEAKER_01", "Erik Lund"), null);
  assert.equal(sameNameAs(rows, "SPEAKER_01", "  "), null, "an empty name is nobody's");
  assert.equal(sameNameAs([row("SPEAKER_00", "Anna Berg")], "SPEAKER_00", "Anna Berg"), null, "not the row itself");
});
