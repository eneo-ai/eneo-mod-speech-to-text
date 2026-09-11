import assert from "node:assert/strict";
import test from "node:test";
import {
  applySpeakerNames,
  buildEditedMapping,
  buildSpeakerRows,
  getSpeakerMappingInferNames,
  getSpeakerMappingParticipants,
  isSpeakerMappingCheckpoint,
  knownSpeakerNames,
  speakerNamesFromRows,
  unmappedSpeakerLabels,
} from "./speaker-mapping";
import { isSpeakerMappingReviewStep } from "./api";

// Formen Eneo skriver in i checkpointens current_payload_json för ett
// speaker-mapping-steg (se eneo: flows/runtime/step_handlers/speaker_mapping.py).
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

test("names from rows and known names offered in the picker", () => {
  const rows = buildSpeakerRows(payload);
  rows[1] = { ...rows[1], name: "Cecilia" };
  assert.deepEqual(speakerNamesFromRows(rows), {
    SPEAKER_00: "Anna",
    SPEAKER_01: "Cecilia",
  });
  assert.deepEqual(knownSpeakerNames(["Anna", "Bo"], rows), ["Anna", "Bo", "Cecilia"]);
  assert.deepEqual(unmappedSpeakerLabels(buildSpeakerRows(payload)), ["SPEAKER_01"]);
});

test("applySpeakerNames rewrites only the speaker token and keeps unmapped labels", () => {
  const transcript = [
    "[00:00:00 - 00:00:04] SPEAKER_00: Hej SPEAKER_01.",
    "[00:00:05 - 00:00:09] SPEAKER_01: Hallå.",
    "Fri text utan tidsstämpel SPEAKER_00: x",
  ].join("\n");
  assert.equal(
    applySpeakerNames(transcript, { SPEAKER_00: "Anna" }),
    [
      "[00:00:00 - 00:00:04] Anna: Hej SPEAKER_01.",
      "[00:00:05 - 00:00:09] SPEAKER_01: Hallå.",
      "Fri text utan tidsstämpel SPEAKER_00: x",
    ].join("\n"),
  );
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
