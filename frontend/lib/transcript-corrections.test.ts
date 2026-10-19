import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_CORRECTIONS,
  applyCorrections,
  correctedSegmentText,
  correctionRequest,
  correctionsFromResponse,
  correctionWriteProblem,
  effectiveSpeakerNames,
  namesAfterNaming,
  occurrencesForLine,
  prunedSpeakerNames,
  renderReviewedTranscript,
  sameCorrections,
  withLineCorrection,
  withSpeakerEdit,
  type CorrectionSet,
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
  const [o] = occurrencesForLine(0, "Hej och välkomna.", "Hej och välkommen.");
  assert.equal(o.segment_index, 0);
  assert.equal("Hej och välkomna.".slice(o.char_start, o.char_end), o.original);
  assert.ok(o.original.length > 0);
  assert.equal(correctedSegmentText("Hej och välkomna.", [o]), "Hej och välkommen.");
});

test("a pure insertion widens to include a neighbour so original is never empty", () => {
  const [o] = occurrencesForLine(0, "Hej välkomna.", "Hej och välkomna.");
  assert.ok(o.char_end > o.char_start);
  assert.equal(o.original, "Hej välkomna.".slice(o.char_start, o.char_end));
  assert.equal(correctedSegmentText("Hej välkomna.", [o]), "Hej och välkomna.");
  const [atStart] = occurrencesForLine(0, "hej", "Åh hej");
  assert.equal(correctedSegmentText("hej", [atStart]), "Åh hej");
  assert.deepEqual(occurrencesForLine(0, "", "x"), []);
});

test("a deletion and an unchanged line", () => {
  const [o] = occurrencesForLine(0, "Hej och välkomna.", "Hej välkomna.");
  assert.equal(o.corrected, "");
  assert.equal(correctedSegmentText("Hej och välkomna.", [o]), "Hej välkomna.");
  assert.deepEqual(occurrencesForLine(0, "Samma", "Samma"), []);
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
  // A word inserted in the middle: the neighbouring letter is taken along, the rest is left alone.
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
  // "mycket." was dropped; "Hej" and "då." moved by 5 characters.
  assert.deepEqual(
    shown[0].words!.map((w) => [w.word, w.charStart, w.charEnd]),
    [["Tack", 0, 4], ["så", 5, 7], ["Hej", 21, 24], ["då.", 25, 28]],
  );
});

test("applyCorrections rewrites text, drops words on corrected lines and reassigns speakers", () => {
  let set = withLineCorrection(
    EMPTY_CORRECTIONS,
    1,
    occurrencesForLine(1, "Tack så mycket.", "Tack så jättemycket."),
  );
  set = withSpeakerEdit(set, 0, "SPEAKER_00", "SPEAKER_01");
  const { segments: shown, corrected } = applyCorrections(segments, set);
  assert.equal(shown[1].text, "Tack så jättemycket.");
  // The word that was corrected ("mycket.") goes; "Tack", which was not, stays.
  assert.deepEqual(shown[1].words!.map((w) => w.word), ["Tack"]);
  assert.equal(shown[0].speaker, "SPEAKER_01");
  assert.equal(shown[0].text, "Hej och välkomna.");
  assert.deepEqual([...corrected], [1]);
  // The raw data is untouched.
  assert.equal(segments[1].text, "Tack så mycket.");
  assert.equal(segments[1].words?.length, 1);
});

test("re-editing a line replaces its occurrence; reverting removes it", () => {
  let set = withLineCorrection(EMPTY_CORRECTIONS, 0, occurrencesForLine(0, "abc def", "abc deg"));
  set = withLineCorrection(set, 0, occurrencesForLine(0, "abc def", "xyz def"));
  assert.equal(set.occurrences.length, 1);
  // The difference is counted per word: the whole word is the span.
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

test("the plain text names a speaker as the page does: the confirmed name, else Talare N", () => {
  assert.deepEqual(
    renderReviewedTranscript(segments, EMPTY_CORRECTIONS, { SPEAKER_01: " Anna Berg " }).split("\n"),
    ["[00:00:00 - 00:00:04] Talare 1: Hej och välkomna.", "[00:00:04 - 00:00:09] Anna Berg: Tack så mycket."],
  );
});

// ---- Names given after the run (Eneo's speaker_names) ----

const HASH = "a".repeat(64);
const v3: CorrectionSet = { ...EMPTY_CORRECTIONS, schemaVersion: 3, segmentsHash: HASH };

test("the names shown are the step's with those given after the run over them: a name overrides, null takes it away, none inherits", () => {
  const step = { SPEAKER_00: "Anna Berg", SPEAKER_01: "Erik Lund" };
  assert.deepEqual(effectiveSpeakerNames(step, { SPEAKER_00: "Anna Bergström", SPEAKER_01: null, SPEAKER_02: "Sara Holm" }), {
    SPEAKER_00: "Anna Bergström",
    SPEAKER_02: "Sara Holm",
  });
  assert.deepEqual(effectiveSpeakerNames(step, undefined), step, "nothing given: the step's names");
  assert.deepEqual(effectiveSpeakerNames({}, { SPEAKER_00: null }), {}, "no step name to take away");
});

test("names are kept only for a speaker of the transcript or one a speaker edit makes, as Eneo keeps them", () => {
  const split = { segment_index: 0, char_start: 0, char_end: 3, original: "Hej", original_speaker: "SPEAKER_00", speaker: "SPEAKER_02", decision: "confirmed" as const };
  // SPEAKER_01 has no passage left (moved to SPEAKER_00), and keeps its name: it is a label of the transcript.
  const moved = withSpeakerEdit(EMPTY_CORRECTIONS, 1, "SPEAKER_01", "SPEAKER_00");
  const names = { SPEAKER_00: "Anna Berg", SPEAKER_01: null, SPEAKER_02: "Sara Holm", SPEAKER_07: "Ingen" };
  assert.deepEqual(prunedSpeakerNames(names, segments, [...moved.speaker_edits, split]), { SPEAKER_00: "Anna Berg", SPEAKER_01: null, SPEAKER_02: "Sara Holm" });
  // The split undone: its speaker has no passage, and its name goes.
  assert.deepEqual(prunedSpeakerNames(names, segments, []), { SPEAKER_00: "Anna Berg", SPEAKER_01: null });
});

test("a naming keeps the step's name where it is typed again, takes it away where it is emptied, and gives one where none was", () => {
  const step = { SPEAKER_00: "Anna Berg", SPEAKER_01: "Erik Lund" };
  const kept = { SPEAKER_03: "Sara Holm" };
  assert.deepEqual(
    namesAfterNaming(
      [
        { label: "SPEAKER_00", name: " Anna Berg " }, // the step's own: nothing to keep
        { label: "SPEAKER_01", name: "" }, // emptied: Talare 2 again, over the step's name
        { label: "SPEAKER_02", name: "Bertil Ek" }, // a name where there was none
      ],
      step,
      kept,
    ),
    { SPEAKER_01: null, SPEAKER_02: "Bertil Ek", SPEAKER_03: "Sara Holm" },
  );
  // Emptying a name the step never gave removes it: absent is "Talare N" already.
  assert.deepEqual(namesAfterNaming([{ label: "SPEAKER_02", name: null }], step, { SPEAKER_02: "Bertil Ek" }), {});
  // Typed over a name given earlier.
  assert.deepEqual(namesAfterNaming([{ label: "SPEAKER_01", name: "Erik Lindqvist" }], step, { SPEAKER_01: null }), { SPEAKER_01: "Erik Lindqvist" });
});

test("every save sends the names, pruned to the transcript's speakers and the edits' with nulls kept", () => {
  const set: CorrectionSet = { ...v3, speakerNames: { SPEAKER_00: "Anna Berg", SPEAKER_01: null, SPEAKER_05: "Gone" } };
  const body = correctionRequest(set, segments);
  assert.deepEqual(body.speaker_names, { SPEAKER_00: "Anna Berg", SPEAKER_01: null });
  // A set without names sends an empty object, never leaves the field out: the stored names are replaced by what the page holds.
  assert.deepEqual(correctionRequest(v3, segments).speaker_names, {});
});

test("a name Eneo would refuse is said before anything is sent", () => {
  const named = (speakerNames: Record<string, string | null>) => correctionWriteProblem({ ...v3, speakerNames });
  assert.equal(named({ SPEAKER_00: "Anna Berg", SPEAKER_01: null }), null);
  assert.match(named({ SPEAKER_00: "Anna\nBerg" }) ?? "", /en rad/);
  assert.match(named({ SPEAKER_00: "Anna​Berg" }) ?? "", /en rad/, "an invisible character breaks the line Eneo shows it on");
  assert.match(named({ SPEAKER_00: "A".repeat(121) }) ?? "", /högst 120 tecken/);
  assert.equal(named({ SPEAKER_00: "🙂".repeat(120) }), null, "120 characters as Eneo counts them, not UTF-16 units");
  assert.match(named(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`SPEAKER_${String(i).padStart(2, "0")}`, "N"]))) ?? "", /fler än 100/);
  assert.match(named({ Anna: "Anna Berg" }) ?? "", /talare/i, "a name belongs to a speaker label");
});

test("the names are part of what a set is: compared without regard to their order, absent as none", () => {
  assert.equal(sameCorrections({ ...v3, speakerNames: { SPEAKER_00: "Anna", SPEAKER_01: null } }, { ...v3, speakerNames: { SPEAKER_01: null, SPEAKER_00: "Anna" } }), true);
  assert.equal(sameCorrections({ ...v3, speakerNames: {} }, v3), true);
  assert.equal(sameCorrections({ ...v3, speakerNames: { SPEAKER_00: "Anna" } }, v3), false);
  assert.equal(sameCorrections({ ...v3, speakerNames: { SPEAKER_00: null } }, v3), false, "taking a step's name away is a change");
});

test("the names are read with the corrections, and a set whose names Eneo could not have stored is not shown", () => {
  const response = { schema_version: 3, segments_hash: HASH, revision: 2, stale: false, occurrences: [], speaker_edits: [] };
  assert.deepEqual(correctionsFromResponse({ ...response, speaker_names: { SPEAKER_00: "Anna Berg", SPEAKER_01: null } }, segments, HASH).speakerNames, {
    SPEAKER_00: "Anna Berg",
    SPEAKER_01: null,
  });
  assert.deepEqual(correctionsFromResponse(response, segments, HASH).speakerNames, {}, "none stored");
  for (const names of [{ Anna: "Anna Berg" }, { SPEAKER_00: 5 }, ["SPEAKER_00"]]) {
    assert.throws(() => correctionsFromResponse({ ...response, speaker_names: names as never }, segments, HASH), /Talarnamnen/);
  }
});

test("the text names each speaker as the page does, and keeps the brackets of what cannot be told and the parts' headings", () => {
  const parts: TranscriptSegment[] = [
    { fileIndex: 0, start: 0, end: 4, speaker: "SPEAKER_00", text: "Hej och välkomna." },
    { fileIndex: 0, start: 4, end: 6, speaker: "SPEAKER_01", text: "Ja.", speakerAttribution: "provisional", overlapIds: ["o1"] },
    { fileIndex: 1, start: 0, end: 3, speaker: "SPEAKER_01", text: "Tack." },
    { fileIndex: 1, start: 3, end: 5, speaker: "SPEAKER_02", text: "Ingen aning." },
  ];
  const set: CorrectionSet = {
    ...v3,
    speaker_edits: [{ segment_index: 3, char_start: null, char_end: null, original: null, original_speaker: "SPEAKER_02", speaker: null, decision: "unresolved" }],
    speakerNames: { SPEAKER_00: "Anna Berg", SPEAKER_01: null },
  };
  // The step named SPEAKER_01 Erik; the name was taken away after the run, so it is Talare 2 again.
  assert.deepEqual(renderReviewedTranscript(parts, set, { SPEAKER_01: "Erik Lund" }).split("\n"), [
    "## Del 1",
    "",
    "[00:00:00 - 00:00:04] Anna Berg: Hej och välkomna.",
    "[00:00:04 - 00:00:06] [Överlappande tal – osäker talare]: Ja.",
    "## Del 2",
    "",
    "[00:00:00 - 00:00:03] Talare 2: Tack.",
    "[00:00:03 - 00:00:05] [Talare går inte att avgöra]: Ingen aning.",
  ]);
  // Without names the text is as it was.
  assert.equal(renderReviewedTranscript(parts, { ...set, speakerNames: {} }, {}), renderReviewedTranscript(parts, { ...set, speakerNames: undefined }));
});
