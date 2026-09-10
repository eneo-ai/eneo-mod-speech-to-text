import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_CORRECTIONS,
  applyCorrections,
  correctedSegmentText,
  occurrenceForLine,
  occurrencesForLine,
  originalTextFor,
  sameCorrections,
  withLineCorrection,
  withSpeakerEdit,
} from "./transcript-corrections";
import type { TranscriptSegment } from "./transcript";

const segments: TranscriptSegment[] = [
  { fileIndex: 0, start: 0, end: 4, speaker: "SPEAKER_00", text: "Hej och välkomna." },
  {
    fileIndex: 0,
    start: 4,
    end: 9,
    speaker: "SPEAKER_01",
    text: "Tack så mycket.",
    words: [
      { word: "Tack", start: 4, end: 4.5, probability: 0.9, charStart: 0, charEnd: 4, uncertain: false },
    ],
  },
];

test("a replaced word becomes one anchored occurrence", () => {
  const o = occurrenceForLine(0, "Hej och välkomna.", "Hej och välkommen.")!;
  assert.equal(o.segment_index, 0);
  assert.equal("Hej och välkomna.".slice(o.char_start, o.char_end), o.original);
  assert.ok(o.original.length > 0);
  assert.equal(correctedSegmentText("Hej och välkomna.", [o]), "Hej och välkommen.");
});

test("a pure insertion widens to include a neighbour so original is never empty", () => {
  const o = occurrenceForLine(0, "Hej välkomna.", "Hej och välkomna.")!;
  assert.ok(o.char_end > o.char_start);
  assert.equal(o.original, "Hej välkomna.".slice(o.char_start, o.char_end));
  assert.equal(correctedSegmentText("Hej välkomna.", [o]), "Hej och välkomna.");
  const atStart = occurrenceForLine(0, "hej", "Åh hej")!;
  assert.equal(correctedSegmentText("hej", [atStart]), "Åh hej");
  assert.equal(occurrenceForLine(0, "", "x"), null);
});

test("a deletion and an unchanged line", () => {
  const o = occurrenceForLine(0, "Hej och välkomna.", "Hej välkomna.")!;
  assert.equal(o.corrected, "");
  assert.equal(correctedSegmentText("Hej och välkomna.", [o]), "Hej välkomna.");
  assert.equal(occurrenceForLine(0, "Samma", "Samma"), null);
});

test("two edits in one line become two anchored spans, not one", () => {
  const raw = "Ja, och jag är närmare bestämt i salen, det är lite liv och rörelse. Det är paus.";
  const edited = "Ja, och jag är närmare bestämt i salen, det är lite liv och rörelsee. Det är pauss.";
  const occ = occurrencesForLine(1, raw, edited);
  assert.equal(occ.length, 2);
  for (const o of occ) {
    assert.equal(raw.slice(o.char_start, o.char_end), o.original);
    assert.ok(o.original.length > 0);
  }
  assert.deepEqual(
    occ.map((o) => [o.original, o.corrected]),
    [["rörelse.", "rörelsee."], ["paus.", "pauss."]],
  );
  assert.equal(correctedSegmentText(raw, occ), edited);
  // Insättning av ett ord mitt i: grannbokstaven tas med, resten orört.
  const ins = occurrencesForLine(0, "Hej välkomna hit.", "Hej och välkomna hit.");
  assert.equal(ins.length, 1);
  assert.equal(correctedSegmentText("Hej välkomna hit.", ins), "Hej och välkomna hit.");
  assert.ok(ins[0].original.length <= 2, `original was ${JSON.stringify(ins[0].original)}`);
});

test("display ranges point at the corrected spans and untouched words keep their timing", () => {
  const raw: TranscriptSegment = {
    fileIndex: 0,
    start: 0,
    end: 5,
    speaker: "SPEAKER_00",
    text: "Tack så mycket. Hej då.",
    words: [
      { word: "Tack", start: 0, end: 0.4, probability: 0.9, charStart: 0, charEnd: 4, uncertain: false },
      { word: "så", start: 0.5, end: 0.6, probability: 0.9, charStart: 5, charEnd: 7, uncertain: false },
      { word: "mycket.", start: 0.7, end: 1.2, probability: 0.9, charStart: 8, charEnd: 15, uncertain: false },
      { word: "Hej", start: 2, end: 2.3, probability: 0.9, charStart: 16, charEnd: 19, uncertain: false },
      { word: "då.", start: 2.4, end: 2.8, probability: 0.9, charStart: 20, charEnd: 23, uncertain: false },
    ],
  };
  const set = withLineCorrection(
    EMPTY_CORRECTIONS,
    0,
    occurrencesForLine(0, raw.text, "Tack så jättemycket. Hej då."),
  );
  const { segments: shown, ranges } = applyCorrections([raw], set);
  assert.equal(shown[0].text, "Tack så jättemycket. Hej då.");
  const r = ranges.get(0)!;
  assert.equal(r.length, 1);
  assert.equal(shown[0].text.slice(r[0].start, r[0].end), "jättemycket.");
  assert.equal(r[0].original, "mycket.");
  // "mycket." föll bort; "Hej" och "då." flyttades med +5 tecken.
  assert.deepEqual(
    shown[0].words!.map((w) => [w.word, w.charStart, w.charEnd]),
    [["Tack", 0, 4], ["så", 5, 7], ["Hej", 21, 24], ["då.", 25, 28]],
  );
});

test("applyCorrections rewrites text, drops words on corrected lines and reassigns speakers", () => {
  let set = withLineCorrection(
    EMPTY_CORRECTIONS,
    1,
    occurrenceForLine(1, "Tack så mycket.", "Tack så jättemycket."),
  );
  set = withSpeakerEdit(set, 0, "SPEAKER_00", "SPEAKER_01");
  const { segments: shown, corrected } = applyCorrections(segments, set);
  assert.equal(shown[1].text, "Tack så jättemycket.");
  // Ordet som rättades ("mycket.") försvinner; "Tack" (orört) finns kvar.
  assert.deepEqual(shown[1].words!.map((w) => w.word), ["Tack"]);
  assert.equal(shown[0].speaker, "SPEAKER_01");
  assert.equal(shown[0].text, "Hej och välkomna.");
  assert.deepEqual([...corrected], [1]);
  assert.equal(originalTextFor(segments, set, 1), "Tack så mycket.");
  assert.equal(originalTextFor(segments, set, 0), null);
  // Rådata orörd.
  assert.equal(segments[1].text, "Tack så mycket.");
  assert.equal(segments[1].words?.length, 1);
});

test("re-editing a line replaces its occurrence; reverting removes it", () => {
  let set = withLineCorrection(EMPTY_CORRECTIONS, 0, occurrenceForLine(0, "abc def", "abc deg"));
  set = withLineCorrection(set, 0, occurrencesForLine(0, "abc def", "xyz def"));
  assert.equal(set.occurrences.length, 1);
  // Skillnaden räknas per ord: hela ordet blir spannet.
  assert.deepEqual([set.occurrences[0].original, set.occurrences[0].corrected], ["abc", "xyz"]);
  set = withLineCorrection(set, 0, null);
  assert.equal(set.occurrences.length, 0);
});

test("choosing the stored speaker again removes the edit instead of writing a no-op", () => {
  let set = withSpeakerEdit(EMPTY_CORRECTIONS, 0, "SPEAKER_00", "SPEAKER_02");
  assert.deepEqual(set.speaker_edits, [
    {
      segment_index: 0,
      char_start: null,
      char_end: null,
      original: null,
      original_speaker: "SPEAKER_00",
      speaker: "SPEAKER_02",
    },
  ]);
  set = withSpeakerEdit(set, 0, "SPEAKER_00", "SPEAKER_00");
  assert.equal(set.speaker_edits.length, 0);
  assert.equal(sameCorrections(set, EMPTY_CORRECTIONS), true);
});
