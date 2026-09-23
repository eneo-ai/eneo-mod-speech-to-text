import assert from "node:assert/strict";
import test from "node:test";

import { Playback, type MediaLike, type PlayerSource } from "./playback";

/** An audio element that only does what it is told; the test plays the browser's part. */
class FakeMedia implements MediaLike {
  src = "";
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  playbackRate = 1;
  loads: string[] = [];
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {
    this.loads.push(this.src);
    this.currentTime = 0;
    this.duration = Number.NaN;
  }
}

const PARTS: PlayerSource[] = [
  { url: "/a", durationMs: 4_000 },
  { url: "/b", durationMs: 2_000 },
];

/** A playback on a fake element whose first part has loaded. */
function started(sources: readonly PlayerSource[] = PARTS, probe = async () => null as number | null) {
  const playback = new Playback(sources, probe);
  const media = new FakeMedia();
  playback.attach(media);
  // A part the recorder did not time may not say its length either (an old WebM).
  media.duration = sources[0].durationMs != null ? sources[0].durationMs / 1_000 : Number.POSITIVE_INFINITY;
  playback.onLoadedMetadata();
  return { playback, media };
}

/** The browser's side of playing on to `seconds` in the loaded part. */
function playTo(playback: Playback, media: FakeMedia, seconds: number) {
  media.currentTime = seconds;
  playback.onTimeUpdate();
}

test("the position follows the audio: the part, the place in it and on the whole recording", () => {
  const { playback, media } = started();
  assert.equal(media.src, "/a");
  const before = playback.getSnapshot();
  assert.equal(before.started, false, "nothing has played or moved yet");
  assert.equal(before.totalMs, 6_000);

  playback.toggle();
  playback.onPlay();
  playTo(playback, media, 1.5);

  const now = playback.getSnapshot();
  assert.deepEqual([now.part, now.withinMs, now.atMs, now.playing, now.started], [0, 1_500, 1_500, true, true]);
});

test("a seek into another part loads it and lands where asked, playing on when asked to", () => {
  const { playback, media } = started();
  playback.seek(1, 500, true);
  assert.equal(media.src, "/b");
  // Until the part has loaded, its old position must not leak into the new one.
  playTo(playback, media, 0);
  assert.equal(playback.getSnapshot().withinMs, 500);

  media.duration = 2;
  playback.onLoadedMetadata();
  assert.equal(media.currentTime, 0.5);
  assert.equal(media.paused, false);
  assert.deepEqual([playback.getSnapshot().part, playback.getSnapshot().atMs], [1, 4_500]);

  playback.seek(1, 1_000, false);
  assert.equal(media.currentTime, 1, "the same part seeks in place");
  assert.equal(media.loads.length, 2, "without loading it again");
});

test("the recording plays on across its parts and starts over after the end", () => {
  const { playback, media } = started();
  playback.toggle();
  playback.onPlay();
  playTo(playback, media, 4);
  playback.onEnded();
  assert.equal(media.src, "/b");
  media.duration = 2;
  playback.onLoadedMetadata();
  assert.equal(media.paused, false, "the next part plays at once");

  playTo(playback, media, 2);
  media.paused = true;
  playback.onEnded();
  const end = playback.getSnapshot();
  assert.deepEqual([end.part, end.atMs, end.playing], [1, 6_000, false]);

  playback.toggle();
  assert.equal(media.src, "/a", "Spela upp after the end starts from the first part");
  assert.equal(playback.getSnapshot().atMs, 0);
});

test("a recording whose length is still unknown resumes where it paused, and starts over only after its end", () => {
  const { playback, media } = started([{ url: "/a", durationMs: null }]);
  playback.toggle();
  playback.onPlay();
  playTo(playback, media, 12);
  playback.toggle();
  playback.onPause();
  playback.toggle();
  assert.deepEqual([media.currentTime, media.paused, media.loads.length], [12, false, 1], "Spela upp resumes at 12 s");

  playTo(playback, media, 20);
  media.paused = true;
  playback.onEnded();
  playback.toggle();
  assert.deepEqual([media.currentTime, media.paused], [0, false], "after its end it plays from the start");
});

test("range playback stops at its end, and any other move ends the range", () => {
  const { playback, media } = started();
  playback.playRange(0, 1_000, 2_000);
  assert.equal(media.currentTime, 1);
  assert.equal(media.paused, false);
  playTo(playback, media, 1.9);
  assert.equal(media.paused, false);
  playTo(playback, media, 2.05);
  assert.equal(media.paused, true, "paused at the range's end");

  playback.playRange(0, 1_000, 2_000);
  playback.seek(0, 500, true);
  playTo(playback, media, 2.5);
  assert.equal(media.paused, false, "a seek ended the range");
});

test("a move right after Pausa stays paused, before the element's pause event has arrived", () => {
  const { playback, media } = started();
  playback.toggle();
  playback.onPlay();
  playback.toggle();
  playback.seekAt(0);
  assert.equal(media.paused, true);
  playback.seek(1, 0);
  media.duration = 2;
  playback.onLoadedMetadata();
  assert.equal(media.paused, true, "nor does a part it loads start playing");
});

test("skip moves over the whole recording and stays inside it", () => {
  const { playback, media } = started();
  playTo(playback, media, 3.5);
  playback.skip(1_000);
  assert.deepEqual([playback.getSnapshot().part, playback.getSnapshot().withinMs], [1, 500]);
  playback.skip(-10_000);
  assert.deepEqual([playback.getSnapshot().part, playback.getSnapshot().withinMs], [0, 0]);
  playback.skip(60_000);
  assert.deepEqual([playback.getSnapshot().part, playback.getSnapshot().atMs], [1, 6_000]);
});

test("the slider's position picks the part and the place in it", () => {
  const { playback, media } = started();
  playback.seekAt(5_000);
  assert.equal(media.src, "/b");
  assert.deepEqual([playback.getSnapshot().part, playback.getSnapshot().withinMs], [1, 1_000]);
  playback.seekAt(0);
  assert.deepEqual([playback.getSnapshot().part, playback.getSnapshot().withinMs], [0, 0]);
});

test("part lengths come from the audio when the recorder does not know them", async () => {
  const probed: string[] = [];
  const unknown: PlayerSource[] = [
    { url: "/a", durationMs: null },
    { url: "/b", durationMs: null },
  ];
  const playback = new Playback(unknown, async (url) => {
    probed.push(url);
    return 2_500;
  });
  const media = new FakeMedia();
  playback.attach(media);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(probed, ["/b"], "the loading part tells its own length");

  media.duration = 3.2;
  playback.onLoadedMetadata();
  assert.deepEqual(playback.getSnapshot().lengthsMs, [3_200, 2_500]);
  assert.equal(playback.getSnapshot().totalMs, 5_700);
});

test("a part whose audio does not say its length grows as it plays and learns it at its end", () => {
  const { playback, media } = started([
    { url: "/a", durationMs: null },
    { url: "/b", durationMs: 2_000 },
  ]);
  playTo(playback, media, 7);
  assert.equal(playback.getSnapshot().withinMs, 7_000, "the position is never cut to an unknown length");
  playback.skip(5_000);
  assert.equal(playback.getSnapshot().withinMs, 12_000, "skip stays in the part while its length is unknown");
  playTo(playback, media, 9);
  playback.onEnded();
  assert.deepEqual(playback.getSnapshot().lengthsMs, [9_000, 2_000]);

  // Known now: a skip from late in the part goes on into the next one.
  playback.seek(0, 7_000);
  media.duration = Number.POSITIVE_INFINITY;
  playback.onLoadedMetadata();
  playback.skip(3_000);
  assert.deepEqual([playback.getSnapshot().part, playback.getSnapshot().withinMs], [1, 1_000]);
});

test("the speed carries over to the next part, and an audio error can be retried at the same place", () => {
  const { playback, media } = started();
  playback.setRate(1.5);
  assert.equal(media.playbackRate, 1.5);
  playback.seek(1, 0, false);
  media.playbackRate = 1;
  media.duration = 2;
  playback.onLoadedMetadata();
  assert.equal(media.playbackRate, 1.5);

  playTo(playback, media, 1.2);
  playback.onError();
  assert.equal(playback.getSnapshot().unavailable, true);
  playback.reload();
  assert.equal(playback.getSnapshot().unavailable, false);
  assert.equal(media.loads.at(-1), "/b");
  media.duration = 2;
  playback.onLoadedMetadata();
  assert.equal(media.currentTime, 1.2);
});

test("without audio the playhead still moves, for a transcript to highlight from", () => {
  const playback = new Playback([]);
  playback.seek(1, 3_000, true);
  assert.deepEqual([playback.getSnapshot().part, playback.getSnapshot().withinMs], [1, 3_000]);
});

test("the same parts given again change nothing; new parts start from the beginning", () => {
  const { playback, media } = started();
  playTo(playback, media, 2);
  playback.setSources(PARTS.map((part) => ({ ...part })));
  assert.equal(playback.getSnapshot().withinMs, 2_000);
  playback.setSources([{ url: "/c", durationMs: 1_000 }]);
  assert.equal(media.src, "/c");
  assert.deepEqual([playback.getSnapshot().withinMs, playback.getSnapshot().started], [0, false]);
});
