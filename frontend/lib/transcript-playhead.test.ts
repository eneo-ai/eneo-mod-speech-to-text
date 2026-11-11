import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { cleanup, installDom, mount } from "./test-dom";
import { Playback, type MediaLike } from "./playback";
import type { TranscriptSegment } from "./transcript";
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
    useTranscriptPlayhead(root, playback, segments.slice(0, 2), (index) => followed.push(index));
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
