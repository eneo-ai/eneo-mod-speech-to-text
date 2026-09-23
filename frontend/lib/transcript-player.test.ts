import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { shortcut, TranscriptPlayer } from "../components/TranscriptPlayer";
import { Playback, type MediaLike } from "./playback";
import { findActiveSegmentIndex, type TranscriptSegment } from "./transcript";

const segments: TranscriptSegment[] = [
  { fileIndex: 0, start: 0, end: 2, speaker: "SPEAKER_00", text: "Välkomna till mötet." },
  { fileIndex: 0, start: 2, end: 4, speaker: "SPEAKER_01", text: "Tack, vi börjar med budgeten." },
  { fileIndex: 1, start: 0.5, end: 1.5, speaker: "SPEAKER_00", text: "Andra delen börjar här." },
];

function render(fileCount: number) {
  return renderToStaticMarkup(
    createElement(TranscriptPlayer, {
      segments,
      fileCount,
      audioSrcFor: (i: number) => `/audio/${i}`,
      speakerNames: {},
      textFallback: "",
      reviewEnabled: false,
    }),
  );
}

test("the transcript's controls are the app's one player, with speed, skips and the parts", () => {
  const html = render(2);
  assert.match(html, /role="group" aria-label="Uppspelning: Inspelningen"/);
  assert.match(html, /<button[^>]*aria-label="Spela upp"/);
  assert.match(html, /aria-label="Position"/);
  assert.match(html, /aria-label="Bakåt 10 sekunder"/);
  assert.match(html, /aria-label="Framåt 10 sekunder"/);
  assert.match(html, /aria-label="Hastighet 1×"/);
  assert.match(html, /aria-pressed="true"[^>]*>Del 1</);
  assert.match(html, /aria-pressed="false"[^>]*>Del 2</);
  assert.equal(html.match(/<audio/g)?.length, 1, "one audio element for every part");
  assert.doesNotMatch(html, /<audio[^>]*controls|type="range"/, "never the browser's own controls");
});

test("a transcript without audio shows no controls and says why", () => {
  const html = render(0);
  assert.doesNotMatch(html, /Uppspelning:|<audio/);
  assert.match(html, /Ljudet är inte tillgängligt för den här körningen\./);
});

test("the highlight follows the playhead in each part's own time, as the transcript counts it", () => {
  const media: MediaLike = {
    src: "",
    currentTime: 0,
    duration: Number.NaN,
    paused: true,
    playbackRate: 1,
    play: async () => undefined,
    pause: () => undefined,
    load: () => undefined,
  };
  const playback = new Playback(
    [
      { url: "/audio/0", durationMs: null },
      { url: "/audio/1", durationMs: null },
    ],
    async () => 2_000,
  );
  playback.attach(media);
  media.duration = 4;
  playback.onLoadedMetadata();
  const highlighted = () => {
    const { part, withinMs } = playback.getSnapshot();
    return findActiveSegmentIndex(segments, part, withinMs / 1_000);
  };

  media.currentTime = 2.5;
  playback.onTimeUpdate();
  assert.equal(highlighted(), 1);

  // A click on a word in the second part seeks there, as TranscriptPlayer.seekTo does.
  playback.seek(1, 1_000, true);
  media.duration = 2;
  playback.onLoadedMetadata();
  media.currentTime = 1;
  playback.onTimeUpdate();
  assert.equal(highlighted(), 2, "the second part's segment, not one 5 s into the first");
});

test("the transcript's keys: Space and K play or pause, arrows move 5 s, J and L 10 s", () => {
  assert.deepEqual(shortcut(" "), { skipMs: 0, preventDefault: true });
  assert.deepEqual(shortcut("K"), { skipMs: 0, preventDefault: true });
  assert.deepEqual(shortcut("ArrowLeft"), { skipMs: -5_000, preventDefault: true });
  assert.deepEqual(shortcut("ArrowRight"), { skipMs: 5_000, preventDefault: true });
  assert.deepEqual(shortcut("j"), { skipMs: -10_000, preventDefault: false });
  assert.deepEqual(shortcut("l"), { skipMs: 10_000, preventDefault: false });
  assert.equal(shortcut("a"), null);
  assert.equal(shortcut("Enter"), null);
});
