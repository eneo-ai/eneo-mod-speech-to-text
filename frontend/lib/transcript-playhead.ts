import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import type { Playback } from "./playback";
import { findActiveSegmentIndex, findActiveSegmentIndices, findActiveWordIndex, type TranscriptSegment } from "./transcript";

/** What the playhead lights at `time` seconds into `part`: the sentences it is in, their words being said, and the one to keep in view. */
export type PlayheadTargets = {
  segments: number[];
  words: { segment: number; word: number }[];
  follow: number;
};

export const NOTHING_LIT: PlayheadTargets = { segments: [], words: [], follow: -1 };

export function playheadTargets(segments: readonly TranscriptSegment[], part: number, time: number): PlayheadTargets {
  const lit = findActiveSegmentIndices(segments, part, time);
  const words = lit.flatMap((segment) => {
    const word = findActiveWordIndex(segments[segment].words ?? [], time);
    return word < 0 ? [] : [{ segment, word }];
  });
  return { segments: lit, words, follow: findActiveSegmentIndex(segments, part, time) };
}

const key = (targets: PlayheadTargets) =>
  `${targets.segments.join(",")}|${targets.words.map((w) => `${w.segment}:${w.word}`).join(",")}`;

/**
 * Lights `targets` in the transcript under `root`: the sentence (`[data-segment-index]`) and its passage
 * (`[data-turn-index]`) get `data-active`, the word's pieces (`[data-word-index]`) `data-lit` and `aria-current`.
 * The list renders none of these, so React never undoes them; whatever this lit before is cleared first.
 */
export function paintPlayhead(root: ParentNode, targets: PlayheadTargets) {
  for (const element of root.querySelectorAll("[data-playhead]")) {
    element.removeAttribute("data-playhead");
    element.removeAttribute("data-active");
    element.removeAttribute("data-lit");
    element.removeAttribute("aria-current");
  }
  const mark = (element: Element, attributes: Record<string, string>) => {
    element.setAttribute("data-playhead", "");
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  };
  for (const segment of targets.segments) {
    const sentence = root.querySelector(`[data-segment-index="${segment}"]`);
    if (!sentence) continue;
    mark(sentence, { "data-active": "true" });
    const turn = sentence.closest("[data-turn-index]");
    if (turn) mark(turn, { "data-active": "true" });
  }
  for (const { segment, word } of targets.words) {
    for (const piece of root.querySelectorAll(`[data-segment-index="${segment}"] [data-word-index="${word}"]`)) {
      mark(piece, { "data-lit": "true", "aria-current": "true" });
    }
  }
}

/**
 * Keeps the transcript under `root` lit where `playback` is, without rendering it again: on every change of the
 * playback, every frame while it plays (so a word lights as it is said, not at the audio's next time update, a
 * quarter of a second later), and after every render of the list. Nothing is lit until playback has started or been
 * moved. `onFollow` hears of each new sentence to keep in view; with `paint` off (a view that lights its own, as the
 * review editor does) that is all it does. Returns the sentence the playhead is in now.
 */
export function useTranscriptPlayhead(
  root: RefObject<HTMLElement | null>,
  playback: Playback,
  segments: readonly TranscriptSegment[],
  onFollow: (segmentIndex: number) => void,
  paint = true,
): () => number {
  const state = useRef({ segments, onFollow, paint, painted: "", follow: -1 });
  state.current.segments = segments;
  state.current.onFollow = onFollow;
  state.current.paint = paint;

  const update = useCallback(
    (repaint: boolean) => {
      const own = state.current;
      const snapshot = playback.getSnapshot();
      const targets = snapshot.started
        ? playheadTargets(own.segments, snapshot.part, playback.liveWithinMs() / 1_000)
        : NOTHING_LIT;
      const painted = key(targets);
      if (own.paint && root.current && (repaint || painted !== own.painted)) paintPlayhead(root.current, targets);
      own.painted = painted;
      if (targets.follow !== own.follow) {
        own.follow = targets.follow;
        if (targets.follow >= 0) own.onFollow(targets.follow);
      }
    },
    [playback, root],
  );

  useEffect(() => {
    let frame = 0;
    const draw = () => {
      update(false);
      frame = playback.getSnapshot().playing ? requestAnimationFrame(draw) : 0;
    };
    const changed = () => {
      update(false);
      if (playback.getSnapshot().playing && !frame) frame = requestAnimationFrame(draw);
    };
    changed();
    const unsubscribe = playback.subscribe(changed);
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
    };
  }, [playback, update]);

  // A render of the list may have put new elements where lit ones were.
  useLayoutEffect(() => update(true));

  return useCallback(() => state.current.follow, []);
}
