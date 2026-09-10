import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_CORRECTIONS,
  applyCorrections,
  correctedSegmentText,
  occurrenceForLine,
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

test("applyCorrections rewrites text, drops words on corrected lines and reassigns speakers", () => {
  let set = withLineCorrection(
    EMPTY_CORRECTIONS,
    1,
    occurrenceForLine(1, "Tack så mycket.", "Tack så jättemycket."),
  );
  set = withSpeakerEdit(set, 0, "SPEAKER_00", "SPEAKER_01");
  const { segments: shown, corrected } = applyCorrections(segments, set);
  assert.equal(shown[1].text, "Tack så jättemycket.");
  assert.equal(shown[1].words, undefined);
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
  let set = withLineCorrection(EMPTY_CORRECTIONS, 0, occurrenceForLine(0, "abc", "abd"));
  set = withLineCorrection(set, 0, occurrenceForLine(0, "abc", "xbc"));
  assert.equal(set.occurrences.length, 1);
  assert.equal(set.occurrences[0].corrected, "x");
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
