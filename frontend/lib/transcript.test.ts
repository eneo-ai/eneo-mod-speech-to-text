import assert from "node:assert/strict";
import test from "node:test";
import {
  attachWords,
  computeTurns,
  countUncertainWords,
  fileIdsFromTranscription,
  findActiveSegmentIndex,
  findActiveWordIndex,
  firstSegmentForSpeaker,
  formatClock,
  locateWords,
  parseTranscriptText,
  segmentsFromTranscription,
  speakerColorIndex,
  speakerDisplayLabel,
} from "./transcript";

const transcription = {
  file_ids: ["file-a", "file-b"],
  segments: [
    { file_index: 0, start: 0.0, end: 4.2, speaker: "SPEAKER_00", text: "Hej och välkomna." },
    { file_index: 0, start: 4.2, end: 6.0, speaker: "SPEAKER_00", text: "Vi börjar." },
    { file_index: 0, start: 6.5, end: 12.0, speaker: "SPEAKER_01", text: "Tack så mycket." },
    { file_index: 1, start: 0.0, end: 3.0, speaker: "SPEAKER_01", text: "Del två." },
  ],
};

test("segments and file ids are read from the transcription metadata", () => {
  const segments = segmentsFromTranscription(transcription);
  assert.equal(segments?.length, 4);
  assert.equal(segments?.[2].speaker, "SPEAKER_01");
  assert.deepEqual(fileIdsFromTranscription(transcription), ["file-a", "file-b"]);
  assert.equal(segmentsFromTranscription({ segments: [] }), null);
  assert.equal(segmentsFromTranscription(null), null);
});

test("rendered transcript text parses as a 1-second-precision fallback", () => {
  const text = [
    "## Del 1",
    "[00:00:00 - 00:00:04] Anna: Hej och välkomna.",
    "[00:00:06 - 00:00:12] SPEAKER_01: Tack så mycket.",
    "Inte en transkriptrad",
    "## Del 2",
    "[00:00:00 - 00:00:03] SPEAKER_01: Del två.",
  ].join("\n");
  const labelFor = (s: string) => (s === "Anna" ? "SPEAKER_00" : s);
  const segments = parseTranscriptText(text, labelFor);
  assert.equal(segments.length, 3);
  assert.deepEqual(segments[0], {
    fileIndex: 0,
    start: 0,
    end: 4,
    speaker: "SPEAKER_00",
    text: "Hej och välkomna.",
  });
  assert.equal(segments[2].fileIndex, 1);
});

test("words are located sequentially with a punctuation retry and uncertainty flag", () => {
  const words = locateWords(
    "Tack så mycket. Tack igen.",
    [
      { word: "Tack", start: 6.5, end: 6.8, probability: 0.9 },
      { word: "så", start: 6.9, end: 7.0, probability: 0 },
      { word: "mycket", start: 7.1, end: 7.6, probability: 0.8 },
      { word: "Tack,", start: 8.0, end: 8.3, probability: 0.7 },
      { word: "saknas", start: 8.4, end: 8.6, probability: 0.5 },
    ],
    "forced",
  );
  assert.deepEqual(
    words.map((w) => [w.charStart, w.charEnd]),
    [[0, 4], [5, 7], [8, 14], [16, 20], [-1, -1]],
  );
  assert.deepEqual(words.map((w) => w.uncertain), [false, true, false, false, false]);
  // Utan forced alignment betyder probability 0 inte osäkerhet.
  assert.equal(
    locateWords("x", [{ word: "x", start: 0, end: 1, probability: 0 }], "provider_words")[0]
      .uncertain,
    false,
  );
});

test("attachWords joins by segment_index and ignores stale or empty payloads", () => {
  const segments = segmentsFromTranscription(transcription)!;
  const withWords = attachWords(segments, {
    alignment: "forced",
    stale: false,
    segments: [
      {
        segment_index: 2,
        words: [
          { word: "Tack", start: 6.5, end: 6.8, probability: 0.9 },
          { word: "så", start: 6.9, end: 7.0, probability: 0 },
        ],
      },
      { segment_index: 99, words: [{ word: "x", start: 0, end: 1 }] },
      { segment_index: 0, words: [] },
    ],
  });
  assert.equal(withWords[2].words?.length, 2);
  assert.equal(withWords[0].words, undefined);
  assert.equal(countUncertainWords(withWords), 1);
  assert.equal(attachWords(segments, { stale: true, segments: [] })[2].words, undefined);
  assert.equal(attachWords(segments, null)[2].words, undefined);
});

test("turns group consecutive same-speaker segments within one file", () => {
  const turns = computeTurns(segmentsFromTranscription(transcription)!);
  assert.deepEqual(
    turns.map((t) => [t.speaker, t.fileIndex, t.parts.length, t.start, t.end]),
    [
      ["SPEAKER_00", 0, 2, 0, 6],
      ["SPEAKER_01", 0, 1, 6.5, 12],
      ["SPEAKER_01", 1, 1, 0, 3],
    ],
  );
});

test("active segment and word follow the playhead, including silences", () => {
  const segments = segmentsFromTranscription(transcription)!;
  assert.equal(findActiveSegmentIndex(segments, 0, 1.0), 0);
  assert.equal(findActiveSegmentIndex(segments, 0, 6.2), 1); // tystnad efter segment 1
  assert.equal(findActiveSegmentIndex(segments, 0, 7.0), 2);
  assert.equal(findActiveSegmentIndex(segments, 1, 1.0), 3);
  assert.equal(findActiveSegmentIndex(segments, 2, 1.0), -1);
  const words = locateWords(
    "a b c",
    [
      { word: "a", start: 0, end: 1 },
      { word: "b", start: 1.5, end: 2 },
      { word: "c", start: 2, end: 3 },
    ],
    null,
  );
  assert.equal(findActiveWordIndex(words, 0.5), 0);
  assert.equal(findActiveWordIndex(words, 1.2), 0);
  assert.equal(findActiveWordIndex(words, 2.5), 2);
  assert.deepEqual(firstSegmentForSpeaker(segments, "SPEAKER_01"), {
    fileIndex: 0,
    time: 6.5,
    segmentIndex: 2,
  });
  assert.equal(firstSegmentForSpeaker(segments, "SPEAKER_09"), null);
});

test("clock, colours and display labels", () => {
  assert.equal(formatClock(65), "01:05");
  assert.equal(formatClock(3725), "1:02:05");
  assert.equal(formatClock(65, true), "0:01:05");
  assert.equal(formatClock(Number.NaN), "00:00");
  assert.equal(speakerColorIndex("SPEAKER_07"), 1);
  assert.equal(speakerDisplayLabel("SPEAKER_00"), "Talare 1");
  assert.equal(speakerDisplayLabel("Anna"), "Anna");
});
