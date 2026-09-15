import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TranscriptPlayer } from "../components/TranscriptPlayer";
import { saveTranscriptCorrections } from "./api";
import { applyCorrections, correctionsFromResponse, correctionRequest, correctionWriteProblem, EMPTY_CORRECTIONS, renderReviewedTranscript, withSpeakerDecision, type CorrectionSet } from "./transcript-corrections";
import { locateWords, type TranscriptSegment } from "./transcript";
import { reviewPassages, speakerReviewsFromTranscription } from "./speaker-review";

const raw: TranscriptSegment = { fileIndex: 0, start: 0, end: 4, text: "ett två tre", speaker: "SPEAKER_00", modelSpeaker: "SPEAKER_00", speakerAttribution: "provisional", overlapIds: ["file-a:overlap_0000"],
  words: locateWords("ett två tre", [{ word: "ett", start: 0, end: 1 }, { word: "två", start: 1, end: 2 }, { word: "tre", start: 2, end: 3 }], null) };
const base: CorrectionSet = { ...EMPTY_CORRECTIONS, schemaVersion: 3, segmentsHash: "a".repeat(64) };
function reload(set: CorrectionSet, segments = [raw]) {
  const request = correctionRequest(set, segments);
  return correctionsFromResponse({ ...request, revision: (set.revision ?? 0) + 1, stale: false }, segments, base.segmentsHash);
}

test("Eneo's files envelope retains namespaced identities and omission state", () => {
  const overlap = { id: "file-a:overlap_0000", start: 1.001, end: 1.002, detected_speaker_count: 2 };
  const reviews = speakerReviewsFromTranscription({ speaker_review: { files: [
    { version: 1, file_index: 0, overlap_detection: "available", overlaps: [overlap] },
    { version: 1, file_index: 1, overlap_detection: "unavailable", overlaps: [] },
  ] } });
  assert.equal(reviews.length, 2);
  assert.equal(reviews[0].overlaps[0].id, overlap.id);
  assert.equal(reviews[0].overlaps[0].start, 1.001);
  assert.equal(reviews[1].overlapDetection, "unavailable");
  const omitted = speakerReviewsFromTranscription({ speaker_review: { files: [{ version: 1, file_index: 0, overlap_detection: "available" }], details_omitted_reason: "too_large" } });
  assert.equal(omitted[0].detailsOmitted, true);
});

test("same-label confirmation, partial override and partial undo round-trip durably", () => {
  let set = reload(withSpeakerDecision(base, [raw], 0, null, null, "confirmed", "SPEAKER_00"));
  assert.equal(set.speaker_edits[0].speaker, raw.speaker);
  assert.equal(reviewPassages(applyCorrections([raw], set).segments, []).length, 0);
  set = reload(withSpeakerDecision(set, [raw], 0, 4, 7, "unresolved", null));
  assert.deepEqual(applyCorrections([raw], set).segments.map((s) => s.decision), ["confirmed", "unresolved", "confirmed"]);
  assert.match(renderReviewedTranscript([raw], set), /Talare går inte att avgöra.*två/);
  set = reload(withSpeakerDecision(set, [raw], 0, 4, 7, null, null));
  assert.deepEqual(applyCorrections([raw], set).segments.map((s) => s.decision), ["confirmed", undefined, "confirmed"]);
  assert.match(renderReviewedTranscript([raw], set), /Överlappande tal – osäker talare.*två/);
  set = reload(withSpeakerDecision(set, [raw], 0, null, null, null, null));
  assert.equal(set.speaker_edits.length, 0);
  assert.equal(applyCorrections([raw], set).segments[0].modelSpeaker, "SPEAKER_00");
});

test("unknown proposals allow confirmation and explicit null-to-null unresolved", () => {
  const unknown = { ...raw, speaker: null, modelSpeaker: null };
  const set = reload(withSpeakerDecision(base, [unknown], 0, null, null, "unresolved", null), [unknown]);
  assert.equal(set.speaker_edits[0].original_speaker, null);
  assert.equal(set.speaker_edits[0].speaker, null);
  const assigned = reload(withSpeakerDecision(set, [unknown], 0, null, null, "confirmed", "SPEAKER_01"), [unknown]);
  assert.equal(applyCorrections([unknown], assigned).segments[0].speaker, "SPEAKER_01");
});

test("UTF-16 word selection uses Eneo Unicode anchors and preserves the server hash", () => {
  const emoji = { ...raw, text: "🙂 ett två", words: undefined };
  const set = withSpeakerDecision(base, [emoji], 0, 7, 10, "confirmed", "SPEAKER_01");
  const body = correctionRequest(set, [emoji]);
  assert.equal(body.speaker_edits[0].char_start, 6);
  assert.equal(body.speaker_edits[0].char_end, 9);
  assert.equal(body.speaker_edits[0].original, "två");
  assert.equal(body.segments_hash, base.segmentsHash);
  assert.deepEqual(reload(set, [emoji]).speaker_edits, set.speaker_edits);
  assert.throws(() => correctionsFromResponse({ ...body, revision: 1, stale: false }, [emoji], "b".repeat(64)), /underlag har ändrats/);
  assert.throws(() => correctionsFromResponse({ ...body, speaker_edits: [{ ...body.speaker_edits[0], char_end: 100 }], revision: 1, stale: false }, [emoji]), /ogiltigt/);
});

test("v3 requires the hash and old full-list writes cannot carry unresolved decisions", () => {
  assert.ok(correctionWriteProblem({ ...base, segmentsHash: null }));
  assert.equal(correctionWriteProblem(base), null);
  const set = withSpeakerDecision(base, [raw], 0, null, null, "unresolved", null);
  assert.throws(() => correctionRequest({ ...set, schemaVersion: 2 }, [raw]), /kräver/);
});

test("the same-origin correction API sends v3 decisions and keeps 409 errors visible", async () => {
  const fetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    requests++;
    assert.equal(input, "/api/eneo/flows/flow/runs/run/steps/step/transcript-corrections/");
    assert.equal(init?.method, "PATCH");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.schema_version, 3);
    assert.equal(body.segments_hash, base.segmentsHash);
    assert.equal(body.speaker_edits[0].decision, "unresolved");
    return requests === 1 ? Response.json({ ...body, revision: 1, stale: false })
      : Response.json({ code: "flow_transcript_corrections_stale_revision", message: "Conflict" }, { status: 409 });
  };
  try {
    const set = withSpeakerDecision(base, [raw], 0, null, null, "unresolved", null);
    const body = correctionRequest(set, [raw]);
    const saved = await saveTranscriptCorrections("flow", "run", "step", body);
    assert.equal(saved.speaker_edits[0].decision, "unresolved");
    await assert.rejects(saveTranscriptCorrections("flow", "run", "step", body), /Conflict/);
    assert.equal(set.speaker_edits[0].decision, "unresolved");
    assert.equal(set.revision, null);
  } finally { globalThis.fetch = fetch; }
});

test("actual player begins with a quiet transcript and direct selection", () => {
  const html = renderToStaticMarkup(createElement(TranscriptPlayer, {
    segments: [raw], speakerReviews: [], reviewEnabled: true, fileCount: 0, audioSrcFor: () => "", speakerNames: {}, textFallback: "",
    corrections: base, editable: true, onCorrectionsChange: () => {}, speakerOptions: ["SPEAKER_00", "SPEAKER_01"],
  }));
  assert.match(html, /aria-label="Transkript, markera ord för att redigera"/);
  assert.match(html, /aria-readonly="false"/);
  assert.match(html, /Nästa passage som behöver talarbeslut/);
  assert.ok(!html.includes("Välj en del av passagen"));
  assert.ok(!html.includes("Från ord"));
});


test("stale word sidecars invalidate inline timings without dropping model evidence", async () => {
  const { attachWords } = await import("./transcript");
  const [shown] = attachWords([raw], { stale: true, segments: [] });
  assert.equal(shown.words, undefined);
  assert.equal(shown.speakerAttribution, "provisional");
  assert.deepEqual(shown.overlapIds, raw.overlapIds);
  assert.equal(raw.words!.length, 3);
});


test("the direct transcript editor retains read-only guards", () => {
  const html = renderToStaticMarkup(createElement(TranscriptPlayer, {
    segments: [raw], speakerReviews: [], reviewEnabled: true, fileCount: 0, audioSrcFor: () => "", speakerNames: {}, textFallback: "",
    corrections: base, editable: false, onCorrectionsChange: () => {},
  }));
  assert.match(html, /aria-readonly="true"/);
  assert.ok(!html.includes("Skriv direkt i texten"));
});
