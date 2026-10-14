import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { cleanup, installDom, mount } from "./test-dom";
import { Playback, type MediaLike } from "./playback";
import type { TranscriptSegment } from "./transcript";
import { NOTHING_LIT, paintPlayhead, playheadTargets } from "./transcript-playhead";

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
  assert.deepEqual(playheadTargets(segments, 0, 1), { segments: [0], words: [{ segment: 0, word: 1 }], follow: 0 });
  assert.deepEqual(playheadTargets(segments, 0, 2.2), { segments: [1], words: [{ segment: 1, word: 0 }], follow: 1 });
  assert.deepEqual(playheadTargets(segments, 1, 1), { segments: [2], words: [{ segment: 2, word: 1 }], follow: 2 });
  // Before the sentence's first word nothing in it is said yet.
  assert.deepEqual(playheadTargets(segments, 0, 0.1).words, []);
});

function list() {
  const root = document.createElement("ol");
  root.innerHTML = segments
    .map(
      (segment, s) =>
        `<li data-turn-index="${s}"><span data-segment-index="${s}">${(segment.words ?? [])
          .map((w, i) => `<span data-word-index="${i}">${w.word}</span> `)
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
  paintPlayhead(root, playheadTargets(segments, 0, 1));
  assert.deepEqual(lit(root), ["punkten."]);
  assert.deepEqual(active(root), ["LI", "SPAN"]);
  assert.equal(root.querySelector("[data-lit]")?.getAttribute("data-lit"), "true");

  paintPlayhead(root, playheadTargets(segments, 0, 2.2));
  assert.deepEqual(lit(root), ["Andra"]);
  assert.equal(root.querySelectorAll('[data-turn-index="0"] [data-active], [data-turn-index="0"][data-active]').length, 0);

  paintPlayhead(root, NOTHING_LIT);
  assert.deepEqual([lit(root), active(root), root.querySelectorAll("[data-playhead]").length], [[], [], 0]);
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
