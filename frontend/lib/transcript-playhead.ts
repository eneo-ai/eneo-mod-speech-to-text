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

/** A sentence's words as rendered: each word's pieces by its index, and the space after each word. */
type SentenceWords = { pieces: HTMLElement[][]; gaps: (HTMLElement | null)[] };

/**
 * Lights the playhead in the transcript under `root`: the sentence (`[data-segment-index]`) and its passage
 * (`[data-turn-index]`) get `data-active`; the word being said (its pieces, `[data-word-index]`) `data-lit` and
 * `aria-current`, filled as far as it is said (`--said`); and the words of its sentence already said `data-said`, with
 * the spaces between them, so a word passed is not switched off but stays a step lighter. The list renders none of
 * these, so React never undoes them.
 *
 * A sentence's words are looked up once, when it is first lit. As the playhead moves on in a sentence only the words
 * passed change, so a long passage costs the same at its end as at its start; a new sentence, a move back or a
 * render of the list paints afresh.
 */
export class PlayheadPainter {
  private lit: PlayheadTargets = NOTHING_LIT;
  private sentences = new Map<number, SentenceWords>();

  constructor(private readonly root: ParentNode) {}

  /** Forgets the elements it knows, which a render of the list may have replaced, and paints afresh next time. */
  reset() {
    this.sentences.clear();
    this.lit = NOTHING_LIT;
    this.clear();
  }

  paint(next: PlayheadTargets) {
    const before = this.lit;
    const moveOn =
      before.segments.join(",") === next.segments.join(",") &&
      next.words.every((w) => (before.words.find((b) => b.segment === w.segment)?.word ?? 0) <= w.word);
    if (!moveOn) {
      this.clear();
      for (const segment of next.segments) {
        const sentence = this.root.querySelector(`[data-segment-index="${segment}"]`);
        if (!sentence) continue;
        mark(sentence, { "data-active": "true" });
        const turn = sentence.closest("[data-turn-index]");
        if (turn) mark(turn, { "data-active": "true" });
      }
    }
    for (const now of next.words) {
      const was = moveOn ? before.words.find((b) => b.segment === now.segment) : undefined;
      if (was?.word === now.word) continue;
      const { pieces, gaps } = this.words(now.segment);
      for (const piece of was ? pieces[was.word] ?? [] : []) {
        piece.removeAttribute("data-lit");
        piece.removeAttribute("aria-current");
        piece.style.removeProperty("--said");
      }
      for (let word = was?.word ?? 0; word < now.word; word++) {
        for (const piece of pieces[word] ?? []) mark(piece, { "data-said": "true" });
        const gap = gaps[word];
        if (gap) mark(gap, { "data-said": "true" });
      }
      for (const piece of pieces[now.word] ?? []) mark(piece, { "data-lit": "true", "aria-current": "true" });
    }
    // A sentence left (two spoken at once, one ending) keeps nothing lit.
    if (moveOn) {
      for (const was of before.words) {
        if (next.words.some((w) => w.segment === was.segment)) continue;
        for (const piece of this.words(was.segment).pieces[was.word] ?? []) {
          piece.removeAttribute("data-lit");
          piece.removeAttribute("aria-current");
        }
      }
    }
    this.sweep(next);
    this.lit = next;
  }

  /** Fills the word being said as far as it has been said: one style property on its pieces. */
  sweep(targets: PlayheadTargets) {
    for (const { segment, word, said } of targets.words) {
      const value = `${Math.round(said * 100)}%`;
      for (const piece of this.words(segment).pieces[word] ?? []) {
        if (piece.style.getPropertyValue("--said") !== value) piece.style.setProperty("--said", value);
      }
    }
  }

  private words(segment: number): SentenceWords {
    let found = this.sentences.get(segment);
    if (found) return found;
    found = { pieces: [], gaps: [] };
    const sentence = this.root.querySelector(`[data-segment-index="${segment}"]`);
    for (const piece of sentence?.querySelectorAll<HTMLElement>("[data-word-index]") ?? []) {
      const index = Number(piece.dataset.wordIndex);
      (found.pieces[index] ??= []).push(piece);
      // The space after a word is the next piece when it is no word: the player renders each piece in a span.
      const gap = piece.parentElement?.nextElementSibling?.firstElementChild as HTMLElement | null | undefined;
      if (gap && !gap.hasAttribute("data-word-index")) found.gaps[index] = gap;
    }
    this.sentences.set(segment, found);
    return found;
  }

  private clear() {
    for (const element of this.root.querySelectorAll<HTMLElement>("[data-playhead]")) {
      element.removeAttribute("data-playhead");
      element.removeAttribute("data-active");
      element.removeAttribute("data-lit");
      element.removeAttribute("data-said");
      element.removeAttribute("aria-current");
      element.style.removeProperty("--said");
    }
  }
}

function mark(element: Element, attributes: Record<string, string>) {
  element.setAttribute("data-playhead", "");
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
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
  const state = useRef({
    segments,
    onFollow,
    paint,
    painted: "",
    follow: -1,
    painter: null as { root: HTMLElement; painter: PlayheadPainter } | null,
  });
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
        if (own.painter?.root !== root.current) own.painter = { root: root.current, painter: new PlayheadPainter(root.current) };
        const { painter } = own.painter;
        if (repaint) painter.reset();
        if (repaint || painted !== own.painted) painter.paint(targets);
        else painter.sweep(targets);
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
