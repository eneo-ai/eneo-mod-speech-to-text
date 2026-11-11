import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TranscriptEditor } from "../components/TranscriptEditor";
import { cleanup, installDom, mount } from "./test-dom";
import { Playback, type MediaLike } from "./playback";
import { computeTurns, locateWords, playbackSpans, playbackWordHighlights, type TranscriptSegment } from "./transcript";
import { applyCorrections } from "./transcript-corrections";
import { NOTHING_LIT, PlayheadPainter, playheadTargets } from "./transcript-playhead";

installDom();
afterEach(cleanup);

const word = (text: string, start: number, end: number) => ({ word: text, start, end, charStart: -1, charEnd: -1, probability: null, uncertain: false });

// Two sentences without speakers, as a flow that times words but does not identify speakers writes them.
const segments: TranscriptSegment[] = [
  { fileIndex: 0, start: 0, end: 2, speaker: null, text: "Första punkten.", words: [word("Första", 0.2, 0.9), word("punkten.", 0.9, 1.8)] },
  { fileIndex: 0, start: 2, end: 4, speaker: null, text: "Andra punkten.", words: [word("Andra", 2.1, 2.7), word("punkten.", 2.7, 3.6)] },
  { fileIndex: 1, start: 0, end: 2, speaker: null, text: "Del två.", words: [word("Del", 0.1, 0.5), word("två.", 0.5, 1.2)] },
];

test("the playhead lights the sentence it is in, the word being said and nothing in another part", () => {
  assert.deepEqual(playheadTargets(segments, 0, 0.9), { segments: [0], words: [{ segment: 0, word: 1, said: 0 }], follow: 0 });
  assert.deepEqual(playheadTargets(segments, 1, 1.2), { segments: [2], words: [{ segment: 2, word: 1, said: 1 }], follow: 2 });
  assert.deepEqual(playheadTargets(segments, 0, 2.4).follow, 1);
  // Before the sentence's first word nothing in it is said yet.
  assert.deepEqual(playheadTargets(segments, 0, 0.1).words, []);
});

// A streamed meeting's spans as the forced alignment gave them, its words replaced by placeholders. The last word of
// an alignment window came back at probability 0 and spread over some 20 s: segment 3's word 9, segment 4's only word
// (which the segment spans too) and segment 7's. [speaker, start, end, words as [start, end, probability 0?]]
const SPREAD: [string, number, number, number[][]][] = [
  ["00", 8.68, 10.71, [[8.68, 8.76], [8.87, 9.09], [9.27, 9.53], [9.57, 9.63], [9.71, 9.99], [10.13, 10.35], [10.41, 10.47], [10.51, 10.71]]],
  ["02", 12.2, 15.43, [[12.2, 12.26], [12.3, 12.36], [12.42, 12.61], [12.69, 13.09], [13.13, 13.19], [13.25, 13.41], [13.73, 13.81], [13.83, 13.89], [13.93, 13.97], [14.09, 14.27], [14.33, 14.53], [14.57, 14.67], [14.69, 14.73], [14.81, 14.91], [14.97, 15.05], [15.11, 15.15], [15.21, 15.43]]],
  ["01", 19.32, 23.0, [[19.32, 19.79], [20.25, 20.31], [20.37, 20.57], [21.47, 21.53], [21.57, 21.69], [21.71, 21.89], [21.95, 22.11], [22.19, 22.39], [22.89, 23.0]]],
  ["02", 25.34, 32.41, [[25.34, 25.42], [25.46, 25.58], [25.7, 25.86], [25.96, 26.02], [26.11, 26.25], [26.35, 26.65], [27.17, 27.25], [27.31, 27.37], [27.45, 27.65], [27.59, 48.3, 0], [27.69, 27.79], [27.83, 27.87], [28.07, 28.39], [28.45, 28.49], [28.57, 28.89], [29.24, 29.26], [30.46, 30.52], [30.56, 30.66], [30.68, 30.85], [30.95, 31.45], [31.55, 31.65], [31.71, 31.93], [31.99, 32.11], [32.15, 32.41]]],
  ["02", 33.83, 54.54, [[33.83, 54.54, 0]]],
  ["01", 35.04, 42.84, [[35.04, 35.24], [35.86, 35.98], [36.08, 36.22], [36.64, 36.92], [37.0, 37.53], [37.63, 37.73], [37.77, 37.81], [39.21, 39.31], [39.39, 39.47], [39.55, 39.65], [39.75, 39.85], [39.95, 40.05], [40.27, 40.47], [40.51, 40.59], [40.63, 40.95], [41.23, 41.47], [41.53, 41.61], [41.71, 41.92], [42.02, 42.2], [42.26, 42.46], [42.5, 42.84]]],
  ["02", 45.02, 51.61, [[45.02, 45.08], [45.42, 45.5], [45.56, 45.72], [45.76, 45.84], [45.88, 46.0], [46.09, 46.19], [46.23, 46.31], [46.37, 46.69], [46.73, 46.81], [46.83, 46.89], [46.95, 47.23], [47.29, 47.41], [47.49, 47.55], [47.79, 47.85], [47.93, 47.99], [48.05, 48.09], [48.15, 48.47], [48.59, 48.79], [48.87, 48.97], [49.01, 49.07], [49.15, 49.31], [49.45, 49.78], [49.94, 50.04], [50.62, 50.66], [50.76, 50.92], [51.08, 51.14], [51.2, 51.25], [51.31, 51.35], [51.39, 51.61]]],
  ["01", 55.67, 82.81, [[55.67, 82.81, 0]]],
];

const spread = (): TranscriptSegment[] =>
  SPREAD.map(([speaker, start, end, spans]) => {
    const text = spans.map((_, i) => `o${i}`).join(" ");
    const words = spans.map(([from, to, zero], i) => ({ word: `o${i}`, start: from, end: to, probability: zero ?? 0.9 }));
    return { fileIndex: 0, start, end, speaker: `SPEAKER_${speaker}`, text, words: locateWords(text, words, "forced") };
  });

/** The same spans as speech without overlaps gives them: each word ends by the next one's start, each sentence by the next one's. */
const apart = (segments: TranscriptSegment[]): TranscriptSegment[] =>
  segments.map((s, i) => {
    const end = Math.min(s.end, segments[i + 1]?.start ?? Infinity);
    return { ...s, end, words: s.words!.map((w, j) => ({ ...w, end: Math.min(w.end, s.words![j + 1]?.start ?? end, end) })) };
  });

/** [segment, word] of each word lit in the review editor. */
const editorLit = (segments: TranscriptSegment[], time: number) =>
  [...playbackWordHighlights(segments, 0, time).keys()].map((w) => {
    const segment = segments.findIndex((s) => s.words?.includes(w));
    return [segment, segments[segment].words!.indexOf(w)];
  });

test("a word spread over its window ends where the next word starts, so it does not hide the words after it", () => {
  // A second recording, with a word that starts inside segment 3's spread word 9 (27.59 to 48.3 s).
  const other = locateWords("o0", [{ word: "o0", start: 27.6, end: 28, probability: 0.9 }], "forced");
  const segments = [...spread(), { fileIndex: 1, start: 27.6, end: 28, speaker: "SPEAKER_00", text: "o0", words: other }];
  const lit = (time: number) => playheadTargets(segments, 0, time).words.map(({ segment, word }) => [segment, word]);
  // Word 9 ends where the next word of its own recording starts, not where the other recording's word does.
  assert.equal(playbackSpans(segments)[3].words![9].end, 27.69);
  assert.deepEqual(editorLit(segments, 27.66), [[3, 9]]);
  // In segment 3's pause after its word 15, that word; not word 9, whose span came spread to 48.3 s.
  assert.deepEqual(lit(30), [[3, 15]]);
  // Where segment 4's spread word came spanning them, one word: the one being said in segment 5, then in segment 6.
  assert.deepEqual(lit(40), [[5, 11]]);
  assert.deepEqual(lit(50), [[6, 22]]);
  // After segment 6, nothing: no sentence is being said, though the spread word came spanning this too.
  assert.deepEqual(lit(52), []);
  // Only the sentence being said is tinted: not the one the spread word ends, nor the one it came spanning.
  assert.deepEqual([30, 40, 50, 52].map((time) => playheadTargets(segments, 0, time).segments), [[3], [5], [6], []]);
  // The review editor lights the same words, and holds the last one said in the pause.
  assert.deepEqual([30, 40, 50, 52].map((time) => editorLit(segments, time)), [[[3, 15]], [[5, 11]], [[6, 22]], [[6, 28]]]);
});

test("a sentence that ends with a spread word is not followed past its words", () => {
  const segments = spread();
  const turns = computeTurns(segments);
  const passage = (time: number) => {
    const { follow } = playheadTargets(segments, 0, time);
    return turns.find((turn) => turn.parts.some((part) => part.segmentIndex === follow))!.index;
  };
  // Segment 4 joins segment 3 in passage 3 and came spanning passages 4 and 5, which start after it.
  assert.deepEqual([30, 40, 50, 52].map(passage), [3, 4, 5, 5]);
});

test("the review editor tints only the word being said, while it lasts", () => {
  const segments = spread();
  const tinted = (time: number) => {
    const html = renderToStaticMarkup(createElement(TranscriptEditor, {
      raw: segments, shown: segments, reviews: [], editable: false, textEditable: false, displayName: (label) => label ?? "",
      speakerOptions: [], audioAvailable: true, currentFile: 0, currentTime: time, playing: true, onSeek: () => {},
      onInteract: () => {}, confirmedWords: new Set<string>(),
    }));
    return [...html.matchAll(/<span data-word-start="([\d.]+)"[^>]*data-active=""/g)].map((match) => Number(match[1]));
  };
  // At 30 s in a pause of segment 3, at 52 s after segment 6: no word is being said, though spread words span both.
  assert.deepEqual([30, 40, 50, 52].map(tinted), [[], [39.95], [49.94], []]);
});

test("speech that really overlaps lights both words, and the follow goes back to the sentence still being said", () => {
  const words = (text: string, spans: [number, number][]) =>
    locateWords(text, text.split(" ").map((word, i) => ({ word, start: spans[i][0], end: spans[i][1], probability: 0.9 })), "forced");
  const segments: TranscriptSegment[] = [
    { fileIndex: 0, start: 0, end: 4, speaker: "SPEAKER_00", text: "a b", words: words("a b", [[0, 2], [2, 4]]) },
    { fileIndex: 0, start: 1, end: 1.5, speaker: "SPEAKER_01", text: "c", words: words("c", [[1, 1.5]]) },
  ];
  const at = (time: number) => {
    const { words: lit, follow } = playheadTargets(segments, 0, time);
    return { lit: lit.map(({ segment, word }) => [segment, word]), follow };
  };
  assert.deepEqual(at(1.2), { lit: [[0, 0], [1, 0]], follow: 0 });
  assert.deepEqual(at(3), { lit: [[0, 1]], follow: 0 });
  assert.deepEqual(editorLit(segments, 1.2), [[0, 0], [1, 0]]);
});

test("a corrected word keeps its audio: the spread word ends where it starts, and its sentence lasts through it", () => {
  const raw: TranscriptSegment[] = [{
    fileIndex: 0, start: 0, end: 10, speaker: "SPEAKER_00", text: "a b c",
    words: locateWords("a b c", [
      { word: "a", start: 0, end: 10, probability: 0 }, { word: "b", start: 1, end: 2, probability: 0.9 },
      { word: "c", start: 2, end: 3, probability: 0.9 },
    ], "forced"),
  }];
  const corrected = (at: number, original: string) => applyCorrections(raw, {
    occurrences: [{ segment_index: 0, char_start: at, char_end: at + 1, original, corrected: original.toUpperCase() }],
    speaker_edits: [], revision: 1,
  }).segments;
  // b corrected to B: at 1.5 s "a" is held, said in full, not lit on as if B were not being said.
  const b = corrected(2, "b");
  assert.deepEqual(playheadTargets(b, 0, 1.5, raw).words.map(({ word, said }) => [b[0].words![word].word, said]), [["a", 1]]);
  assert.deepEqual([...playbackWordHighlights(b, 0, 1.5, raw)].map(([word, saying]) => [word.word, saying]), [["a", false]]);
  // c corrected to C: at 2.5 s, while C is said, its sentence is lit.
  assert.deepEqual(playheadTargets(corrected(4, "c"), 0, 2.5, raw).segments, [0]);
});

const correctionOf = (raw: TranscriptSegment[], segment: number, at: number, original: string) => applyCorrections(raw, {
  occurrences: [{ segment_index: segment, char_start: at, char_end: at + original.length, original, corrected: original.toUpperCase() }],
  speaker_edits: [], revision: 1,
}).segments;

const editorActive = (raw: TranscriptSegment[], shown: TranscriptSegment[], time: number) =>
  [...renderToStaticMarkup(createElement(TranscriptEditor, {
    raw, shown, reviews: [], editable: false, textEditable: false, displayName: (label) => label ?? "",
    speakerOptions: [], audioAvailable: true, currentFile: 0, currentTime: time, playing: true, onSeek: () => {},
    onInteract: () => {}, confirmedWords: new Set<string>(),
  })).matchAll(/<span (?:data-word-start="([\d.]+)" )?[^>]*data-active=""/g)].map((match) => match[1] ?? "no word");

test("a spread word corrected away still ends where the next word starts, and so does its sentence", () => {
  const raw: TranscriptSegment[] = [
    { fileIndex: 0, start: 0, end: 10, speaker: "SPEAKER_00", text: "a b c", words: locateWords("a b c", [
      { word: "a", start: 0, end: 10, probability: 0 }, { word: "b", start: 1, end: 2, probability: 0.9 },
      { word: "c", start: 2, end: 3, probability: 0.9 },
    ], "forced") },
    { fileIndex: 0, start: 4, end: 6, speaker: "SPEAKER_01", text: "d", words: locateWords("d", [{ word: "d", start: 4, end: 6, probability: 0.9 }], "forced") },
  ];
  const shown = correctionOf(raw, 0, 0, "a");
  const at5 = playheadTargets(shown, 0, 5, raw);
  assert.deepEqual([at5.segments, at5.follow], [[1], 1]);
  // In the meeting, segment 4's only word corrected: at 40 s the passage being said is followed, not the one it spread over.
  const meeting = spread();
  const fixed = correctionOf(meeting, 4, 0, "o0");
  const turns = computeTurns(fixed);
  const { follow } = playheadTargets(fixed, 0, 40, meeting);
  assert.equal(turns.find((turn) => turn.parts.some((part) => part.segmentIndex === follow))!.index, 4);
  // The review editor does not tint the corrected sentence after its cut end either.
  assert.deepEqual(editorActive(meeting, fixed, 40), ["39.95"]);
});

test("the review editor times a corrected transcript by the words as they came", () => {
  const raw: TranscriptSegment[] = [{ fileIndex: 0, start: 0, end: 10, speaker: "SPEAKER_00", text: "a b c", words: locateWords("a b c", [
    { word: "a", start: 0, end: 10, probability: 0 }, { word: "b", start: 1, end: 2, probability: 0.9 },
    { word: "c", start: 2, end: 3, probability: 0.9 },
  ], "forced") }];
  // b corrected: at 1.5 s B is being said, so "a" is not tinted as being said.
  assert.deepEqual(editorActive(raw, correctionOf(raw, 0, 2, "b"), 1.5), []);
});

test("playback spans are read again for another source", () => {
  const raw: TranscriptSegment[] = [{ fileIndex: 0, start: 0, end: 10, speaker: "SPEAKER_00", text: "a b c", words: locateWords("a b c", [
    { word: "a", start: 0, end: 10, probability: 0 }, { word: "b", start: 1, end: 2, probability: 0.9 },
    { word: "c", start: 2, end: 3, probability: 0.9 },
  ], "forced") }];
  const shown = correctionOf(raw, 0, 2, "b");
  assert.equal(playbackSpans(shown)[0].words![0].end, 2);
  assert.equal(playbackSpans(shown, raw)[0].words![0].end, 1);
});

test("spans with no spread word are lit and followed as they come", () => {
  const segments = apart(spread());
  // The rule before: the first span the time is in, else the last one started.
  const first = (spans: readonly { start: number; end: number }[], time: number) => {
    let last = -1;
    for (let i = 0; i < spans.length; i++) {
      if (time >= spans[i].start && time < spans[i].end) return i;
      if (spans[i].start <= time) last = i;
    }
    return last;
  };
  for (let ms = 0; ms <= 60_000; ms += 10) {
    const time = ms / 1_000;
    const { segments: lit, words, follow } = playheadTargets(segments, 0, time);
    assert.equal(follow, first(segments, time), `followed at ${time}`);
    const before = lit.flatMap((s) => (first(segments[s].words!, time) < 0 ? [] : [[s, first(segments[s].words!, time)]]));
    assert.deepEqual(words.map(({ segment, word }) => [segment, word]), before, `lit at ${time}`);
    // The editor: the word being said, else the one that ended last.
    const all = segments.flatMap((s, i) => s.words!.map((w, j) => ({ ...w, at: [i, j] })));
    const now = all.filter((w) => time >= w.start && time < w.end);
    const ended = all.filter((w) => w.end <= time).sort((a, b) => a.end - b.end).slice(-1);
    assert.deepEqual(editorLit(segments, time), (now.length ? now : ended).map((w) => w.at), `editor at ${time}`);
  }
});

test("a word fills at its own pace: a long one slowly, a short one at once, and stays full in the pause after it", () => {
  const said = (time: number) => playheadTargets(segments, 0, time).words[0]?.said;
  // "punkten." lasts 0.9 s: halfway through, half of it is said.
  assert.equal(said(1.35)!.toFixed(3), "0.500");
  assert.equal(said(1.79)! > 0.98, true);
  // Between "punkten." (ends 1.8) and the next sentence the word stays said.
  assert.equal(said(1.9), 1);
});

function list() {
  const root = document.createElement("ol");
  root.innerHTML = segments
    .map(
      (segment, s) =>
        `<li data-turn-index="${s}"><span data-segment-index="${s}">${(segment.words ?? [])
          // As the player renders a piece: a word, then the space after it, each in a span of its own.
          .map((w, i) => `<span data-word-index="${i}">${w.word}</span><span> </span>`)
          .join("")}</span></li>`,
    )
    .join("");
  document.body.append(root);
  return root;
}

const lit = (root: ParentNode) => [...root.querySelectorAll('[aria-current="true"]')].map((element) => element.textContent);
const active = (root: ParentNode) => [...root.querySelectorAll('[data-active="true"]')].map((element) => element.tagName);

test("painting lights the passage, its sentence and the word, and clears what was lit before", () => {
  const root = list();
  const painter = new PlayheadPainter(root);
  painter.paint(playheadTargets(segments, 0, 1.35));
  assert.deepEqual(lit(root), ["punkten."]);
  assert.deepEqual(active(root), ["LI", "SPAN"]);
  const word = root.querySelector<HTMLElement>("[data-lit]")!;
  assert.equal(word.style.getPropertyValue("--said"), "50%", "filled as far as it is said");
  // The word before it stays lit a step lighter instead of going out.
  assert.deepEqual([...root.querySelectorAll("[data-said]")].map((element) => element.textContent), ["Första", " "], "with the space after it");

  painter.paint(playheadTargets(segments, 0, 2.2));
  assert.deepEqual(lit(root), ["Andra"]);
  assert.equal(root.querySelectorAll('[data-turn-index="0"] [data-active], [data-turn-index="0"][data-active]').length, 0);
  assert.equal(root.querySelectorAll('[data-turn-index="0"] [data-said]').length, 0, "a sentence left keeps nothing said");

  painter.paint(NOTHING_LIT);
  assert.deepEqual([lit(root), active(root), root.querySelectorAll("[data-playhead]").length], [[], [], 0]);
  assert.equal(word.style.getPropertyValue("--said"), "", "its fill is cleared too");
});

test("in a long passage a word moving on changes only the words passed, without looking the passage up again", () => {
  const long: TranscriptSegment[] = [
    {
      fileIndex: 0, start: 0, end: 600, speaker: "SPEAKER_00", text: "",
      words: Array.from({ length: 600 }, (_, i) => word(`ord${i}`, i, i + 1)),
    },
  ];
  const root = document.createElement("ol");
  root.innerHTML = `<li data-turn-index="0"><span data-segment-index="0">${long[0].words!
    .map((w, i) => `<span data-word-index="${i}">${w.word}</span><span> </span>`)
    .join("")}</span></li>`;
  document.body.append(root);
  const painter = new PlayheadPainter(root);
  painter.paint(playheadTargets(long, 0, 590.5));
  assert.equal(root.querySelectorAll("[data-said]").length, 590 * 2);

  let lookups = 0;
  const count = <T extends (...args: never[]) => unknown>(f: T) => ((...args: Parameters<T>) => (lookups++, f(...args))) as T;
  root.querySelectorAll = count(root.querySelectorAll.bind(root));
  root.querySelector = count(root.querySelector.bind(root));
  const changed: string[] = [];
  const observer = new MutationObserver((records) => records.forEach((r) => changed.push(r.attributeName ?? "")));
  observer.observe(root, { attributes: true, subtree: true });
  painter.paint(playheadTargets(long, 0, 591.5));
  const records = observer.takeRecords();
  observer.disconnect();
  assert.equal(lookups, 0, "the passage's words are known");
  assert.ok(records.length + changed.length < 20, `a handful of changes, not the whole passage (${records.length})`);
  assert.deepEqual(lit(root), ["ord591"]);
  assert.equal(root.querySelectorAll("[data-said]").length, 591 * 2);

  // Back in the passage: painted afresh, nothing past the playhead stays said.
  painter.paint(playheadTargets(long, 0, 10.5));
  assert.deepEqual(lit(root), ["ord10"]);
  assert.equal(root.querySelectorAll("[data-said]").length, 10 * 2);
});

function media(): MediaLike & { paused: boolean } {
  return {
    src: "", currentTime: 0, duration: 4, paused: true, playbackRate: 1,
    play: async () => undefined, pause: () => undefined, load: () => undefined, removeAttribute: () => undefined,
  };
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

test("while the audio plays the word lights as it is said, between the audio's time updates, and the list is not rendered again", async () => {
  const { createElement, useRef } = await import("react");
  const { useTranscriptPlayhead } = await import("./transcript-playhead");
  const playback = new Playback([{ url: "/audio/0", durationMs: 4_000 }], async () => null);
  const audio = media();
  playback.attach(audio);
  playback.onLoadedMetadata();
  let renders = 0;
  const followed: number[] = [];
  function View() {
    renders += 1;
    const root = useRef<HTMLOListElement>(null);
    useTranscriptPlayhead(root, playback, segments.slice(0, 2), segments.slice(0, 2), (index) => followed.push(index));
    return createElement(
      "ol",
      { ref: root },
      segments.slice(0, 2).map((segment, s) =>
        createElement(
          "li",
          { key: s, "data-turn-index": s },
          createElement(
            "span",
            { "data-segment-index": s },
            (segment.words ?? []).map((w, i) => createElement("span", { key: i, "data-word-index": i }, `${w.word} `)),
          ),
        ),
      ),
    );
  }
  const view = await mount(createElement(View));
  assert.deepEqual(lit(view.container), [], "nothing lit before playback has started");

  // Playing from 0.3 s: the snapshot says so once, at the play event.
  await view.act(async () => {
    playback.seek(0, 300, true);
    audio.currentTime = 0.3;
    audio.paused = false;
    playback.onPlay();
  });
  assert.deepEqual(lit(view.container), ["Första "]);
  const rendered = renders;

  // The audio moves on without a time update: the next frame reads it from the element.
  audio.currentTime = 2.2;
  await frame();
  await frame();
  assert.deepEqual(lit(view.container), ["Andra "]);
  assert.deepEqual(followed, [0, 1], "the new sentence is kept in view");
  assert.equal(renders, rendered, "lit without rendering the list");

  await view.act(async () => {
    audio.paused = true;
    playback.onPause();
  });
  playback.attach(null);
});
