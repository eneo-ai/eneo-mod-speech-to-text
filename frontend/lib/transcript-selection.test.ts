import assert from "node:assert/strict";
import test from "node:test";
import { applyCorrections, correctionRequest, EMPTY_CORRECTIONS, withLineCorrection, withSpeakerDecision, type CorrectionSet } from "./transcript-corrections";
import { pendingSpeakerSuggestions, confirmSpeakerSuggestions, replaceTranscriptText, displayedSourceOffset, anchorTextSelection, selectionSpeakerSuggestion, wholePassageSelection, assignTextSelection, displayedSelectionBounds, selectedTranscriptText, transcriptParagraphs } from "./transcript-selection";
import { locateWords, playbackWordHighlights, type TranscriptSegment } from "./transcript";

const base: CorrectionSet = { ...EMPTY_CORRECTIONS, schemaVersion: 3, segmentsHash: "a".repeat(64), revision: 8 };
const raw: TranscriptSegment[] = [
  { fileIndex: 0, start: 0, end: 1, text: "Vi ses", speaker: "SPEAKER_00", modelSpeaker: "SPEAKER_00", speakerAttribution: "assigned" },
  { fileIndex: 0, start: 1, end: 2, text: "igen imorgon.", speaker: "SPEAKER_00", modelSpeaker: "SPEAKER_00", speakerAttribution: "provisional", overlapIds: ["o1"] },
];

test("selection spans source boundaries and assigns only the selected words in one request", () => {
  const shown = applyCorrections(raw, base).segments;
  const selection = anchorTextSelection([{ index: 0, start: 4, end: 6 }, { index: 1, start: 0, end: 2 }], shown, base);
  assert.deepEqual(selection, [{ segmentIndex: 0, start: 3, end: 6 }, { segmentIndex: 1, start: 0, end: 4 }]);
  assert.equal(selectedTranscriptText(selection, raw, base), "ses igen");
  const next = assignTextSelection(base, raw, selection, "confirmed", "SPEAKER_01");
  const out = applyCorrections(raw, next).segments;
  assert.deepEqual(out.map((s) => [s.text, s.speaker]), [["Vi ", "SPEAKER_00"], ["ses", "SPEAKER_01"], ["igen", "SPEAKER_01"], [" imorgon.", "SPEAKER_00"]]);
  assert.equal(next.revision, 8);
  assert.equal(correctionRequest(next, raw).speaker_edits.length, 2);
  assert.equal(transcriptParagraphs(out, raw).length, 1);
});

test("paragraphs stay coherent through uncertainty, confirmations and partial reassignments", () => {
  assert.equal(transcriptParagraphs(applyCorrections(raw, base).segments, raw).length, 1);
  const next = withSpeakerDecision(base, raw, 1, 5, 13, "confirmed", "SPEAKER_01");
  assert.equal(transcriptParagraphs(applyCorrections(raw, next).segments, raw).length, 1);
  const files = [...raw, { ...raw[0], fileIndex: 1 }];
  assert.equal(transcriptParagraphs(applyCorrections(files, base).segments, files).length, 2);
});

test("already corrected words resolve to their full original anchor", () => {
  const corrected = withLineCorrection(base, 0, { segment_index: 0, char_start: 3, char_end: 6, original: "ses", corrected: "träffas snart" });
  const shown = applyCorrections(raw, corrected).segments;
  const selected = anchorTextSelection([{ index: 0, start: 12, end: 14 }], shown, corrected);
  assert.deepEqual(selected, [{ segmentIndex: 0, start: 3, end: 6 }]);
  assert.equal(selectedTranscriptText(selected, raw, corrected), "träffas snart");
  const next = assignTextSelection(corrected, raw, selected, "confirmed", "SPEAKER_01");
  assert.equal(applyCorrections(raw, next).segments[1].text, "träffas snart");
});

test("selection after a length-changing correction and prior speaker split keeps exact offsets", () => {
  const source = [{ ...raw[0], text: "Hej 😊 där igen" }];
  const corrected = withLineCorrection(base, 0, { segment_index: 0, char_start: 0, char_end: 3, original: "Hej", corrected: "Hallå där" });
  const split = withSpeakerDecision(corrected, source, 0, 7, 10, "confirmed", "SPEAKER_01");
  const shown = applyCorrections(source, split).segments;
  const selected = anchorTextSelection([{ index: 2, start: 2, end: 4 }], shown, split);
  assert.equal(selectedTranscriptText(selected, source, split), "igen");
  assert.deepEqual(selected, [{ segmentIndex: 0, start: 11, end: 15 }]);
  const request = correctionRequest(assignTextSelection(split, source, selected, "confirmed", "SPEAKER_00"), source);
  assert.equal(request.speaker_edits.at(-1)?.char_start, 10);
});

test("unresolved and range reset work without word timings and preserve unrelated decisions", () => {
  const chosen = [{ segmentIndex: 0, start: 3, end: 6 }];
  const original = withSpeakerDecision(base, raw, 1, null, null, "confirmed", "SPEAKER_00");
  const unresolved = assignTextSelection(original, raw, chosen, "unresolved", null);
  assert.equal(applyCorrections(raw, unresolved).segments[1].decision, "unresolved");
  const undone = assignTextSelection(unresolved, raw, chosen, null, null);
  assert.deepEqual(undone.speaker_edits, original.speaker_edits);
});

test("whitespace alone never produces a speaker mutation", () => {
  const shown = applyCorrections(raw, base).segments;
  assert.deepEqual(anchorTextSelection([{ index: 0, start: 2, end: 3 }], shown, base), []);
});

test("selection highlight survives a save that splits the original segment", () => {
  const selected = [{ segmentIndex: 0, start: 3, end: 6 }];
  const next = assignTextSelection(base, raw, selected, "confirmed", "SPEAKER_01");
  const shown = applyCorrections(raw, next).segments;
  assert.equal(displayedSelectionBounds(selected[0], shown[0], 0, next), null);
  assert.deepEqual(displayedSelectionBounds(selected[0], shown[1], 1, next), { start: 0, end: 3 });
});


test("whitespace left around a reviewed word does not create a phantom review task", async () => {
  const { reviewPassages } = await import("./speaker-review");
  const source = [{ ...raw[1], text: " hej " }];
  const next = assignTextSelection(base, source, [{ segmentIndex: 0, start: 1, end: 4 }], "confirmed", "SPEAKER_00");
  assert.equal(reviewPassages(applyCorrections(source, next).segments, []).length, 0);
});


test("whole-passage selection includes trailing punctuation and whitespace", () => {
  const source = [{ ...raw[1], text: "  Är det så? ...  " }];
  const shown = applyCorrections(source, base).segments;
  const selected = wholePassageSelection(0, shown, source);
  assert.deepEqual(selected, [{ segmentIndex: 0, start: 0, end: source[0].text.length }]);
  const next = assignTextSelection(base, source, selected, "confirmed", "SPEAKER_00");
  assert.equal(next.speaker_edits[0].char_start, null);
  assert.equal(next.speaker_edits[0].char_end, null);
  assert.equal(applyCorrections(source, next).segments.length, 1);
});

test("whole-passage selection respects an existing decision boundary after text correction", () => {
  const source = [{ ...raw[1], text: "Hej där, igen." }];
  const split = withSpeakerDecision(base, source, 0, 0, 3, "confirmed", "SPEAKER_01");
  const corrected = withLineCorrection(split, 0, { segment_index: 0, char_start: 4, char_end: 8, original: "där,", corrected: "där borta," });
  const shown = applyCorrections(source, corrected).segments;
  const selected = wholePassageSelection(1, shown, source);
  assert.deepEqual(selected, [{ segmentIndex: 0, start: 3, end: 14 }]);
  assert.equal(selectedTranscriptText(selected, source, corrected), " där borta, igen.");
  const next = assignTextSelection(corrected, source, selected, "confirmed", "SPEAKER_00");
  assert.equal(next.speaker_edits[0].speaker, "SPEAKER_01");
  assert.equal(next.speaker_edits[1].original, " där, igen.");
});


test("quick confirmation uses one shared model suggestion and persists a same-speaker decision", () => {
  const shown = applyCorrections(raw, base).segments;
  const suggestion = selectionSpeakerSuggestion(shown);
  assert.equal(suggestion, "SPEAKER_00");
  const selected = wholePassageSelection(1, shown, raw);
  const next = assignTextSelection(base, raw, selected, "confirmed", suggestion);
  assert.equal(next.speaker_edits[0].speaker, "SPEAKER_00");
  assert.equal(next.speaker_edits[0].decision, "confirmed");
  assert.deepEqual(applyCorrections(raw, next).segments[1].overlapIds, raw[1].overlapIds);
});

test("quick confirmation never guesses across mixed, unknown, or already overridden suggestions", () => {
  assert.equal(selectionSpeakerSuggestion([]), null);
  assert.equal(selectionSpeakerSuggestion([{ ...raw[0], modelSpeaker: null }]), null);
  assert.equal(selectionSpeakerSuggestion([raw[0], { ...raw[1], modelSpeaker: "SPEAKER_01" }]), null);
  assert.equal(selectionSpeakerSuggestion([{ ...raw[0], speaker: "SPEAKER_01", decision: "confirmed" }]), null);
  assert.equal(selectionSpeakerSuggestion([{ ...raw[0], speaker: null, decision: "unresolved" }]), null);
  assert.equal(selectionSpeakerSuggestion([{ ...raw[0], decision: "confirmed" }, raw[1]]), "SPEAKER_00");
});


test("a corrected speaker at the end of a paragraph joins their following continuation", () => {
  const source = [
    { ...raw[0], text: "Nu måste vi prata allvar. Jag har läst den flera gånger.", start: 24, end: 29 },
    { ...raw[0], speaker: "SPEAKER_01", modelSpeaker: "SPEAKER_01", text: "än vad du har gjort.", start: 29, end: 31 },
  ];
  const initial = applyCorrections(source, base).segments;
  assert.equal(transcriptParagraphs(initial, source).length, 2);
  const start = source[0].text.indexOf("Jag");
  const next = withSpeakerDecision(base, source, 0, start, source[0].text.length, "confirmed", "SPEAKER_01");
  const shown = applyCorrections(source, next).segments;
  assert.deepEqual(transcriptParagraphs(shown, source), [[0, 1, 2]]);
  assert.equal(shown[2].sourceSegmentIndex, 1);
  assert.equal(shown[2].start, 29);
  const undone = withSpeakerDecision(next, source, 0, start, source[0].text.length, null, null);
  assert.equal(transcriptParagraphs(applyCorrections(source, undone).segments, source).length, 2);
});

test("continuations retain file, pause and reading-length boundaries", () => {
  const first = { ...raw[0], text: "Jag har läst den flera gånger.", start: 24, end: 29 };
  const second = { ...raw[0], speaker: "SPEAKER_01", modelSpeaker: "SPEAKER_01", text: "än vad du har gjort.", start: 29, end: 31 };
  for (const source of [[first, { ...second, fileIndex: 1 }], [first, { ...second, start: 33, end: 35 }], [{ ...first, text: "ord ".repeat(170) }, second]]) {
    const next = withSpeakerDecision(base, source, 0, null, null, "confirmed", "SPEAKER_01");
    assert.equal(transcriptParagraphs(applyCorrections(source, next).segments, source).length, 2);
  }
});

test("matching uncertain or unresolved speakers do not remove a source paragraph boundary", () => {
  const source = [raw[0], { ...raw[0], speaker: "SPEAKER_01", modelSpeaker: "SPEAKER_01" }];
  const shown = applyCorrections(source, base).segments;
  const uncertain = [{ ...shown[0], speaker: "SPEAKER_01", speakerAttribution: "provisional" as const }, shown[1]];
  assert.equal(transcriptParagraphs(uncertain, source).length, 2);
  const unresolved = [{ ...shown[0], speaker: null, decision: "unresolved" as const }, { ...shown[1], speaker: null, decision: "unresolved" as const }];
  assert.equal(transcriptParagraphs(unresolved, source).length, 2);
});


test("playback highlight holds through word and segment gaps, then advances at the next onset", () => {
  const source = [
    { ...raw[0], text: "Vi ses", words: locateWords("Vi ses", [{ word: "Vi", start: 0, end: 0.5 }, { word: "ses", start: 1, end: 1.5 }], null) },
    { ...raw[1], text: "imorgon.", start: 2, end: 3, words: locateWords("imorgon.", [{ word: "imorgon.", start: 2, end: 3 }], null) },
  ];
  const at = (time: number, file = 0) => [...playbackWordHighlights(source, file, time)].map((w) => w.word);
  assert.deepEqual(at(0.5), ["Vi"]);
  assert.deepEqual(at(0.9), ["Vi"]);
  assert.deepEqual(at(1), ["ses"]);
  assert.deepEqual(at(1.8), ["ses"]);
  assert.deepEqual(at(2), ["imorgon."]);
  assert.deepEqual(at(8), ["imorgon."]);
  assert.deepEqual(at(0.7), ["Vi"]); // Backward seeking derives the correct word without stale state.
  assert.deepEqual(at(-1), []);
  assert.deepEqual(at(2, 1), []);
  assert.equal(source[0].words[0].end, 0.5); // Display persistence never extends actual timing.
});

test("overlapping words remain visible and only the last-finishing word persists into silence", () => {
  const source = [
    { ...raw[0], words: locateWords("Vi ses", [{ word: "Vi", start: 0, end: 3 }, { word: "ses", start: 1, end: 2 }], null) },
  ];
  const at = (time: number) => [...playbackWordHighlights(source, 0, time)].map((w) => w.word);
  assert.deepEqual(at(1.5), ["Vi", "ses"]);
  assert.deepEqual(at(2.5), ["Vi"]);
  assert.deepEqual(at(3.5), ["Vi"]);
  assert.equal(playbackWordHighlights([{ ...source[0], words: undefined }], 0, 4).size, 0);
});


test("inline punctuation uses the exact caret and preserves speaker decisions", () => {
  const source = [{ ...raw[0], text: "AnnieBehåll den där." }];
  const set = withSpeakerDecision(base, source, 0, 0, 5, "confirmed", "SPEAKER_01");
  const shown = applyCorrections(source, set).segments;
  const result = replaceTranscriptText(set, source, shown, [{ index: 0, start: 5, end: 5 }], ". ");
  assert.deepEqual(applyCorrections(source, result.corrections).segments.map((s) => [s.text, s.speaker]), [["Annie. ", "SPEAKER_01"], ["Behåll den där.", "SPEAKER_00"]]);
  assert.deepEqual(result.corrections.speaker_edits, set.speaker_edits);
  assert.deepEqual(result.caret, { segmentIndex: 0, offset: 7 });
  assert.equal(correctionRequest(result.corrections, source).expected_revision, 8);
  assert.equal(source[0].text, "AnnieBehåll den där.");
});

test("continued typing and deletion inside a previous correction keep exact positions", () => {
  const source = [{ ...raw[0], text: "Hej igen" }];
  let set = withLineCorrection(base, 0, { segment_index: 0, char_start: 0, char_end: 3, original: "Hej", corrected: "Hallå där" });
  let shown = applyCorrections(source, set).segments;
  const inserted = replaceTranscriptText(set, source, shown, [{ index: 0, start: 5, end: 5 }], ".");
  set = inserted.corrections;
  shown = applyCorrections(source, set).segments;
  assert.equal(shown[0].text, "Hallå. där igen");
  assert.equal(inserted.caret.offset, 6);
  const removed = replaceTranscriptText(set, source, shown, [{ index: 0, start: 5, end: 6 }], "");
  assert.equal(applyCorrections(source, removed.corrections).segments[0].text, "Hallå där igen");
  assert.equal(removed.caret.offset, 5);
});

test("exact replacement across source segments removes only selected characters", () => {
  const shown = applyCorrections(raw, base).segments;
  const result = replaceTranscriptText(base, raw, shown, [{ index: 0, start: 4, end: 6 }, { index: 1, start: 0, end: 2 }], "å ");
  assert.deepEqual(applyCorrections(raw, result.corrections).segments.map((s) => s.text), ["Vi så ", "en imorgon."]);
  assert.deepEqual(result.caret, { segmentIndex: 0, offset: 6 });
});

test("insertion next to emoji keeps valid code-point anchors on the wire", () => {
  const source = [{ ...raw[0], text: "Hej 😊" }];
  const result = replaceTranscriptText(base, source, applyCorrections(source, base).segments, [{ index: 0, start: 6, end: 6 }], " ");
  const request = correctionRequest(result.corrections, source);
  assert.equal(request.occurrences[0].original, "😊");
  assert.equal(request.occurrences[0].char_start, 4);
  assert.equal(request.occurrences[0].char_end, 5);
  assert.equal(applyCorrections(source, result.corrections).segments[0].text, "Hej 😊 ");
});

test("typing in a later speaker fragment accounts for previous length-changing corrections", () => {
  const source = [{ ...raw[0], text: "Hej där igen" }];
  const corrected = withLineCorrection(base, 0, { segment_index: 0, char_start: 0, char_end: 3, original: "Hej", corrected: "Hallå där" });
  const set = withSpeakerDecision(corrected, source, 0, 8, 12, "confirmed", "SPEAKER_01");
  const shown = applyCorrections(source, set).segments;
  const result = replaceTranscriptText(set, source, shown, [{ index: 1, start: 4, end: 4 }], ".");
  const out = applyCorrections(source, result.corrections).segments;
  assert.deepEqual(out.map((s) => s.text), ["Hallå där där ", "igen."]);
  assert.equal(result.caret.offset, 19);
  assert.equal(displayedSourceOffset(out[1], 1, 5, result.corrections).offset, 19);
  assert.deepEqual(result.corrections.speaker_edits, set.speaker_edits);
});


test("bulk accept confirms each pending proposal with its own speaker and preserves other changes", () => {
  const source = [
    { ...raw[1], text: "Annie pratar", speaker: "SPEAKER_00", modelSpeaker: "SPEAKER_00" },
    { ...raw[1], text: "Stefan svarar", speaker: "SPEAKER_01", modelSpeaker: "SPEAKER_01", fileIndex: 1 },
    { ...raw[1], text: "Oklart", speaker: null, modelSpeaker: null },
  ];
  let set = withSpeakerDecision(base, source, 0, 0, 5, "confirmed", "SPEAKER_02");
  set = withLineCorrection(set, 1, { segment_index: 1, char_start: 7, char_end: 13, original: "svarar", corrected: "svarar." });
  const proposals = pendingSpeakerSuggestions(source, applyCorrections(source, set).segments, set);
  assert.equal(proposals.length, 2);
  const next = confirmSpeakerSuggestions(set, source, proposals);
  const shown = applyCorrections(source, next).segments;
  assert.deepEqual(shown.map((s) => [s.text, s.speaker, s.decision]), [
    ["Annie", "SPEAKER_02", "confirmed"], [" pratar", "SPEAKER_00", "confirmed"],
    ["Stefan svarar.", "SPEAKER_01", "confirmed"], ["Oklart", null, undefined],
  ]);
  assert.deepEqual(next.occurrences, set.occurrences);
  assert.equal(next.revision, set.revision);
  assert.equal(pendingSpeakerSuggestions(source, shown, next).length, 0);
  assert.deepEqual(applyCorrections(source, { ...next, occurrences: set.occurrences, speaker_edits: set.speaker_edits }).segments,
    applyCorrections(source, set).segments);
});

test("bulk accept in a mixed selection respects its exact source boundaries", () => {
  const source = [{ ...raw[1], text: "ett två tre" }, { ...raw[1], text: "fyra fem", speaker: "SPEAKER_01", modelSpeaker: "SPEAKER_01" }];
  const selected = [{ segmentIndex: 0, start: 4, end: 11 }, { segmentIndex: 1, start: 0, end: 4 }];
  const proposals = pendingSpeakerSuggestions(source, applyCorrections(source, base).segments, base, selected);
  const next = confirmSpeakerSuggestions(base, source, proposals);
  assert.deepEqual(applyCorrections(source, next).segments.map((s) => [s.text, s.decision]), [
    ["ett ", undefined], ["två tre", "confirmed"], ["fyra", "confirmed"], [" fem", undefined],
  ]);
});

test("bulk accept leaves unresolved, legacy human edits and passages without proposals alone", () => {
  const source = [raw[1], { ...raw[1] }, { ...raw[1], speaker: null, modelSpeaker: null }, raw[0]];
  let set = withSpeakerDecision(base, source, 0, null, null, "unresolved", null);
  set = withSpeakerDecision(set, source, 1, null, null, "confirmed", "SPEAKER_00");
  set = { ...set, speaker_edits: set.speaker_edits.map((e) => e.segment_index === 1 ? { ...e, decision: undefined } : e) };
  const proposals = pendingSpeakerSuggestions(source, applyCorrections(source, set).segments, set);
  assert.deepEqual(proposals, []);
  assert.equal(confirmSpeakerSuggestions(set, source, proposals), set);
});
