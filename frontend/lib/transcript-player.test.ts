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

test("the transcript's controls are the app's one player, with speed and skips, and each part is its own list", () => {
  const html = render(2);
  assert.match(html, /role="group" aria-label="Uppspelning: Inspelningen"/);
  assert.match(html, /<button[^>]*aria-label="Spela upp"/);
  assert.match(html, /aria-label="Position i inspelningen"/);
  assert.match(html, /aria-label="Bakåt 10 sekunder"/);
  assert.match(html, /aria-label="Framåt 10 sekunder"/);
  assert.match(html, /aria-label="Hastighet 1×"/);
  assert.match(html, /<h3[^>]*>Del 1<\/h3><ol[^>]*aria-label="Del 1"/);
  assert.match(html, /<h3[^>]*>Del 2<\/h3><ol[^>]*aria-label="Del 2"/);
  assert.doesNotMatch(html, /aria-pressed="true"[^>]*>Del/, "no part buttons that repeat the headings");
  // The player comes after the text it plays, so it can stay docked under it.
  assert.ok(html.indexOf("Välkomna till mötet.") < html.indexOf("Uppspelning: Inspelningen"));
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

test("turn times read like the player's clock, m:ss, each in its own part's time", () => {
  const long: TranscriptSegment[] = [
    ...segments,
    { fileIndex: 1, start: 3_725, end: 3_730, speaker: "SPEAKER_01", text: "Efter en timme." },
  ];
  for (const reviewEnabled of [false, true]) {
    const html = renderToStaticMarkup(
      createElement(TranscriptPlayer, {
        segments: long,
        fileCount: 2,
        audioSrcFor: (i: number) => `/audio/${i}`,
        speakerNames: {},
        textFallback: "",
        reviewEnabled,
      }),
    );
    assert.doesNotMatch(html, /\b00:0\d\b/, `no zero-padded minutes (${reviewEnabled ? "review" : "reading"} view)`);
    if (reviewEnabled) {
      assert.match(html, /aria-label="Flytta uppspelningen till 0:00"/);
    } else {
      assert.match(html, /aria-label="Spela från 0:02 i del 1"[^>]*>0:02</);
      assert.match(html, /aria-label="Spela från 1:02:05 i del 2"[^>]*>1:02:05</, "hours only where the time has them");
      // Each part starts over at 0:00, so the name says which part.
      assert.match(html, /aria-label="Spela från 0:00 i del 1"/);
      assert.match(html, /aria-label="Spela från 0:00 i del 2"/);
    }
  }
});

test("a transcript without speaker labels names no speaker, and nothing is lit before playback", () => {
  const html = (segments: TranscriptSegment[]) =>
    renderToStaticMarkup(
      createElement(TranscriptPlayer, {
        segments,
        fileCount: 1,
        audioSrcFor: () => "/audio/0",
        speakerNames: {},
        textFallback: "",
        reviewEnabled: false,
      }),
    );
  const unlabelled = html([
    { fileIndex: 0, start: 0, end: 24, speaker: null, text: "Välkomna till nämndens möte den 23 september." },
    { fileIndex: 0, start: 24, end: 30, speaker: null, text: "Första punkten." },
  ]);
  assert.doesNotMatch(unlabelled, /Okänd talare/, "the flow did not label speakers; saying 'unknown' misleads");
  assert.doesNotMatch(unlabelled, /data-active="true"/, "the first block is not lit before anything plays");

  const labelled = html(segments);
  assert.match(labelled, /Talare 1/);
  assert.match(labelled, /Talare 2/);
});

test("the review view names no speaker for an unlabelled transcript either", () => {
  const html = renderToStaticMarkup(
    createElement(TranscriptPlayer, {
      segments: [{ fileIndex: 0, start: 0, end: 24, speaker: null, text: "Välkomna till nämndens möte." }],
      fileCount: 1,
      audioSrcFor: () => "/audio/0",
      speakerNames: {},
      textFallback: "",
      reviewEnabled: true,
    }),
  );
  assert.match(html, /Välkomna till nämndens möte\./);
  assert.doesNotMatch(html, /Okänd talare/);
});

test("no instruction lines: the pencil names its passage and is fully there on a touch screen", () => {
  const html = renderToStaticMarkup(
    createElement(TranscriptPlayer, {
      segments,
      fileCount: 2,
      audioSrcFor: (i: number) => `/audio/${i}`,
      speakerNames: {},
      textFallback: "",
      reviewEnabled: false,
      editable: true,
      corrections: { occurrences: [], speaker_edits: [], revision: null },
      onCorrectionsChange: () => undefined,
    }),
  );
  const shown = html.replace(/<[^>]+>/g, " ");
  assert.doesNotMatch(shown, /hovra|klicka|Peka på|Tryck på pennan/i);
  const pencils = [...html.matchAll(/<button[^>]*aria-label="Rätta repliken från ([^"]+)"[^>]*class="([^"]*)"/g)];
  assert.deepEqual(pencils.map(([, time]) => time), ["0:00", "0:02", "0:00"]);
  for (const [, , classes] of pencils) assert.match(classes, /coarse:opacity-100/);
  // Each passage is a list item named by who speaks and when.
  assert.match(html, /<li[^>]*aria-label="Talare 1, 0:00 i del 1"/);
});
