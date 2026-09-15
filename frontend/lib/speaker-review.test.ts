import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fixtures from "../tests/fixtures/speaker_review.json";
import { TranscriptPlayer } from "../components/TranscriptPlayer";
import { attachWords, computeTurns, effectiveSpeakerLabel, findActiveSegmentIndices, firstSegmentForSpeaker, locateWords, parseTranscriptText, segmentsFromTranscription, speakerDisplayLabel, type TranscriptSegment } from "./transcript";
import { overlapKey, reviewPassages, speakerReviewsFromTranscription } from "./speaker-review";
import { applyCorrections, correctionsFromResponse, correctionWriteProblem, EMPTY_CORRECTIONS, withLineCorrection, withSpeakerEdit, type CorrectionSet } from "./transcript-corrections";

const name = (label: string | null) => label ? speakerDisplayLabel(label) : "Okänd talare";
const fixture = (key: string) => fixtures.cases.find((c) => c.name === key)!.result;
function render(result: unknown, corrections?: CorrectionSet, reviewEnabled = true) {
  return renderToStaticMarkup(createElement(TranscriptPlayer, {
    segments: segmentsFromTranscription(result) ?? [], speakerReviews: speakerReviewsFromTranscription(result),
    fileCount: 0, audioSrcFor: () => "", speakerNames: { SPEAKER_00: "Anna" }, textFallback: "", reviewEnabled, corrections,
  }));
}
for (const example of fixtures.cases) {
  test(`shared ${example.name} fixture through the actual player`, () => {
    const segments = segmentsFromTranscription(example.result)!;
    const html = render(example.result);
    for (const segment of segments) assert.ok(html.replace(/<[^>]*>/g, "").includes(segment.text));
    assert.equal(html.includes("Överlappningsanalys saknas"), example.name === "unavailable");
    assert.equal(html.includes("decoration-dotted"), ["overlap", "three-voices", "wordless-unknown"].includes(example.name));
    if (example.name === "overlap") {
      assert.equal(computeTurns(segments).length, 3);
      assert.ok(html.includes("Förslag: Anna"));
      assert.ok(html.includes("Inte granskat"));
      assert.ok(html.includes("Ljudet är inte tillgängligt"));
    }
    if (example.name === "three-voices") assert.ok(html.includes("3 modellröster"));
  });
}

test("feature switch hides review tools but never settles provisional attribution", () => {
  const html = render(fixture("wordless-unknown"), undefined, false);
  assert.ok(html.includes("Överlappande tal – osäker talare"));
  assert.ok(!html.includes("Förslag:"));
});

test("file-scoped collisions and completely wordless intervals survive", () => {
  const base = fixture("overlap");
  const meta = { segments: [], speaker_review: [
    { ...base.speaker_review, file_index: 0 }, { ...base.speaker_review, file_index: 1 },
  ] };
  const reviews = speakerReviewsFromTranscription(meta);
  const passages = reviewPassages([], reviews);
  assert.equal(passages.length, 2);
  assert.notEqual(passages[0].key, passages[1].key);
  assert.notEqual(overlapKey(0, "x"), overlapKey(1, "x"));
  const html = render(meta);
  assert.ok(html.includes("Inga transkriptord finns"));
  assert.ok(html.includes("2 ställen att granska"));
});

test("metadata and precision survive word sidecars, text fallback and grouping", () => {
  const raw = segmentsFromTranscription(fixture("three-voices"))!;
  const attached = attachWords(raw, { segments: [{ segment_index: 1, words: [{ word: "ses", start: 1.00001, end: 1.49999 }] }] });
  assert.deepEqual(attached[1].overlapIds, raw[1].overlapIds);
  assert.equal(attached[1].words![0].start, 1.00001);
  assert.equal(firstSegmentForSpeaker([raw[1]], "SPEAKER_00"), null);
  assert.equal(firstSegmentForSpeaker([raw[1], raw[2]], "SPEAKER_00")?.segmentIndex, 1);
  const differentIds = [raw[1], { ...raw[1], overlapIds: ["another"] }];
  assert.equal(computeTurns(differentIds).length, 2);
  const fallback = parseTranscriptText(fixture("overlap").text);
  assert.equal(fallback[1].speaker, null);
  assert.equal(effectiveSpeakerLabel(fallback[1], name), "Överlappande tal – osäker talare");
  assert.equal(segmentsFromTranscription({ segments: [null, fixture("clear").segments[0]] }), null);
});

const raw: TranscriptSegment = {
  fileIndex: 0, start: 0, end: 4, speaker: "SPEAKER_00", modelSpeaker: "SPEAKER_00", text: "ett två tre",
  speakerAttribution: "provisional", overlapIds: ["overlap_0000"],
  words: locateWords("ett två tre", [{ word: "ett", start: 0, end: 1 }, { word: "två", start: 1, end: 2 }, { word: "tre", start: 2, end: 3 }], null),
};
const partial: CorrectionSet = { ...EMPTY_CORRECTIONS, schemaVersion: 3, speaker_edits: [{
  segment_index: 0, char_start: 4, char_end: 7, original: "två", original_speaker: "SPEAKER_00", speaker: "SPEAKER_01", decision: "confirmed",
}] };

test("partial v3 decisions survive reload and change only the selected words", () => {
  const set = correctionsFromResponse(JSON.parse(JSON.stringify({ ...partial, schema_version: 3, revision: 4, stale: false })), [raw]);
  const out = applyCorrections([raw], set).segments;
  assert.equal(out.map((s) => s.text).join(""), raw.text);
  assert.deepEqual(out.map((s) => s.speaker), ["SPEAKER_00", "SPEAKER_01", "SPEAKER_00"]);
  assert.deepEqual(out.map((s) => s.modelSpeaker), ["SPEAKER_00", "SPEAKER_00", "SPEAKER_00"]);
  assert.deepEqual(out.map((s) => s.sourceSegmentIndex), [0, 0, 0]);
  assert.deepEqual(out.map((s) => s.sourceCharStart), [0, 4, 7]);
  assert.deepEqual(out[1].words!.map((w) => [w.charStart, w.charEnd, w.start, w.end]), [[0, 3, 1, 2]]);
  assert.equal(computeTurns(out).length, 3);
  assert.equal(effectiveSpeakerLabel(out[0], name), "Överlappande tal – osäker talare");
  assert.equal(effectiveSpeakerLabel(out[1], name), "Talare 2");
  assert.ok(correctionWriteProblem(set));
  assert.equal(raw.speaker, "SPEAKER_00");
  assert.equal(raw.words!.length, 3);
});

test("same-label confirmation, explicit unresolved and undo keep original evidence", () => {
  for (const decision of ["confirmed", "unresolved"] as const) {
    const edit = { ...partial.speaker_edits[0], char_start: null, char_end: null, original: null, speaker: decision === "confirmed" ? "SPEAKER_00" : null, decision };
    const set = { ...partial, speaker_edits: [edit] };
    const [shown] = applyCorrections([raw], set).segments;
    assert.equal(effectiveSpeakerLabel(shown, name), decision === "confirmed" ? "Talare 1" : "Talare går inte att avgöra");
    assert.deepEqual(shown.overlapIds, raw.overlapIds);
    assert.equal(reviewPassages([shown], []).length, 0);
    const [undone] = applyCorrections([raw], { ...set, speaker_edits: [] }).segments;
    assert.equal(effectiveSpeakerLabel(undone, name), "Överlappande tal – osäker talare");
  }
  const unknown = { ...raw, speaker: null, modelSpeaker: null };
  const unresolved = correctionsFromResponse({ schema_version: 3, stale: false, revision: 1, occurrences: [], speaker_edits: [{ ...partial.speaker_edits[0], original_speaker: null, speaker: null, decision: "unresolved" }] }, [unknown]);
  assert.equal(applyCorrections([unknown], unresolved).segments[1].decision, "unresolved");
});

test("text edits invalidate touched timing and preserve all decision fields", () => {
  const set = withLineCorrection(partial, 0, { segment_index: 0, char_start: 4, char_end: 7, original: "två", corrected: "andra" });
  const out = applyCorrections([raw], set).segments;
  assert.equal(out[1].text, "andra");
  assert.deepEqual(out[1].words, []);
  assert.equal(out[2].words![0].word, "tre");
  assert.deepEqual(set.speaker_edits, partial.speaker_edits);
  const crossBoundary = withLineCorrection(partial, 0, { segment_index: 0, char_start: 0, char_end: 7, original: "ett två", corrected: "något" });
  assert.throws(() => applyCorrections([raw], crossBoundary), /talargräns/);
});

test("all intersecting rows stay active, including spans without word timings", () => {
  const out = applyCorrections([{ ...raw, words: undefined }], partial).segments;
  assert.deepEqual(findActiveSegmentIndices(out, 0, 1.5), [0, 1, 2]);
  assert.deepEqual(findActiveSegmentIndices(out, 1, 1.5), []);
  assert.deepEqual(findActiveSegmentIndices(out, 0, 4), []);
});

test("stale and unsupported versions fail closed; v2 reads remain compatible", () => {
  const response = { ...EMPTY_CORRECTIONS, revision: 1, stale: false };
  assert.throws(() => correctionsFromResponse({ ...response, stale: true }, [raw]), /äldre transkript/);
  assert.throws(() => correctionsFromResponse({ ...response, schema_version: 4 }, [raw]), /stöds inte/);
  const v2 = withSpeakerEdit(EMPTY_CORRECTIONS, 0, "SPEAKER_00", "SPEAKER_01");
  const set = correctionsFromResponse({ ...v2, stale: false, revision: 1 }, [raw]);
  assert.equal(applyCorrections([raw], set).segments[0].decision, "confirmed");
  assert.equal(correctionWriteProblem(set), null);
});

test("failed saves preserve ordering and cannot produce approval success", async () => {
  const { appendCorrectionSave } = await import("./transcript-corrections");
  let release!: (ok: boolean) => void;
  const first = new Promise<boolean>((resolve) => { release = resolve; });
  const writes: string[] = [];
  const second = appendCorrectionSave(first, async () => { writes.push("second"); return true; });
  const approval = second.then((saved) => { if (saved) writes.push("approved"); });
  assert.equal(writes.length, 0);
  release(false);
  await approval;
  assert.equal(writes.length, 0);
  assert.equal(await second, false);
  // Explicit retry still uses the original revision, supplied by the caller.
  const retry = appendCorrectionSave(Promise.resolve(true), async () => { writes.push("retry"); return true; });
  await retry.then((saved) => { if (saved) writes.push("approved"); });
  assert.deepEqual(writes, ["retry", "approved"]);
});

test("successful queued replacements land before approval", async () => {
  const { appendCorrectionSave } = await import("./transcript-corrections");
  const order: number[] = [];
  const first = appendCorrectionSave(Promise.resolve(true), async () => { order.push(1); return true; });
  const second = appendCorrectionSave(first, async () => { order.push(2); return true; });
  await second.then((saved) => { if (saved) order.push(3); });
  assert.deepEqual(order, [1, 2, 3]);
});

test("malformed spans, text anchors and decisions are rejected before rendering", () => {
  const response = { occurrences: [], revision: 1, stale: false, schema_version: 3, speaker_edits: partial.speaker_edits };
  assert.throws(() => correctionsFromResponse({ ...response, speaker_edits: [...partial.speaker_edits, ...partial.speaker_edits] }, [raw]), /krockar/);
  assert.throws(() => correctionsFromResponse({ ...response, occurrences: [{ segment_index: 0, char_start: 0, char_end: 3, original: "fel", corrected: "x" }] }, [raw]), /underlag/);
  assert.throws(() => correctionsFromResponse({ ...response, speaker_edits: [{ ...partial.speaker_edits[0], speaker: null }] }, [raw]), /format/);
});
