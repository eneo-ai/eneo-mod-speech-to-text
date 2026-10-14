import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import type { Playback } from "./playback";
import { findActiveSegmentIndex, findActiveSegmentIndices, findActiveWordIndex, type TranscriptSegment } from "./transcript";

/**
 * What the playhead lights at `time` seconds into `part`: the sentences it is in, the word being said in each with how
 * much of it has been said (0 to 1, held at 1 in a pause after it), and the sentence to keep in view.
 */
export type PlayheadTargets = {
  segments: number[];
  words: { segment: number; word: number; said: number }[];
  follow: number;
};

export const NOTHING_LIT: PlayheadTargets = { segments: [], words: [], follow: -1 };

export function playheadTargets(segments: readonly TranscriptSegment[], part: number, time: number): PlayheadTargets {
  const lit = findActiveSegmentIndices(segments, part, time);
  const words = lit.flatMap((segment) => {
    const all = segments[segment].words ?? [];
    const word = findActiveWordIndex(all, time);
    if (word < 0) return [];
    const { start, end } = all[word];
    const said = end > start ? Math.min(1, Math.max(0, (time - start) / (end - start))) : 1;
    return [{ segment, word, said }];
  });
  return { segments: lit, words, follow: findActiveSegmentIndex(segments, part, time) };
}

/** Which words are lit; how far into them is not part of it, as it changes every frame. */
const key = (targets: PlayheadTargets) =>
  `${targets.segments.join(",")}|${targets.words.map((w) => `${w.segment}:${w.word}`).join(",")}`;

const wordPieces = (root: ParentNode, segment: number, word: number) =>
  root.querySelectorAll<HTMLElement>(`[data-segment-index="${segment}"] [data-word-index="${word}"]`);

/**
 * Lights `targets` in the transcript under `root`: the sentence (`[data-segment-index]`) and its passage
 * (`[data-turn-index]`) get `data-active`; the word being said (its pieces, `[data-word-index]`) `data-lit` and
 * `aria-current`, and the words of its sentence already said `data-said`, so a word passed is not switched off but
 * stays a step lighter. The list renders none of these, so React never undoes them; whatever this lit before is
 * cleared first. How much of the word is said is drawn by `sweepPlayhead`.
 */
export function paintPlayhead(root: ParentNode, targets: PlayheadTargets) {
  for (const element of root.querySelectorAll<HTMLElement>("[data-playhead]")) {
    element.removeAttribute("data-playhead");
    element.removeAttribute("data-active");
    element.removeAttribute("data-lit");
    element.removeAttribute("data-said");
    element.removeAttribute("aria-current");
    element.style.removeProperty("--said");
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
    for (let before = 0; before < word; before++) {
      for (const piece of wordPieces(root, segment, before)) {
        mark(piece, { "data-said": "true" });
        // The space after it too, so the words said read as one band rather than a row of pills.
        const gap = piece.parentElement?.nextElementSibling?.firstElementChild;
        if (gap && !gap.hasAttribute("data-word-index")) mark(gap, { "data-said": "true" });
      }
    }
    for (const piece of wordPieces(root, segment, word)) mark(piece, { "data-lit": "true", "aria-current": "true" });
  }
  sweepPlayhead(root, targets);
}

/** Fills the word being said as far as it has been said: one style property on its pieces, so a frame costs nothing. */
export function sweepPlayhead(root: ParentNode, targets: PlayheadTargets) {
  for (const { segment, word, said } of targets.words) {
    const value = `${Math.round(said * 100)}%`;
    for (const piece of wordPieces(root, segment, word)) {
      if (piece.style.getPropertyValue("--said") !== value) piece.style.setProperty("--said", value);
    }
  }
}

const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * Keeps the transcript under `root` lit where `playback` is, without rendering it again: on every change of the
 * playback, every frame while it plays, and after every render of the list. The word being said fills as it is said,
 * at the speech's own pace (a short word quickly, a long one slowly), and the words before it in the sentence stay
 * lit a step lighter, so nothing flickers on and off several times a second. With reduced motion a word is lit whole
 * as it starts. Nothing is lit until playback has started or been moved. `onFollow` hears of each new sentence to keep
 * in view; with `paint` off (a view that lights its own, as the review editor does) that is all it does. Returns the
 * sentence the playhead is in now.
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
      const found = snapshot.started
        ? playheadTargets(own.segments, snapshot.part, playback.liveWithinMs() / 1_000)
        : NOTHING_LIT;
      const targets = reducedMotion() ? { ...found, words: found.words.map((w) => ({ ...w, said: 1 })) } : found;
      const painted = key(targets);
      if (own.paint && root.current) {
        if (repaint || painted !== own.painted) paintPlayhead(root.current, targets);
        else sweepPlayhead(root.current, targets);
      }
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
