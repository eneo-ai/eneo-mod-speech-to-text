// Confirmed uncertain words: "the reviewer has listened and the word is right".
//
// Eneo's correction model (transcript-corrections.ts) holds only text replacements and speaker changes, so a
// confirmation is kept in this browser, per person and per transcription step, and only dims the mark in the player.
// Another person signing in here clears it: it names the words of a transcript.

import { removeOtherOwners } from "./drafts";
import type { TranscriptSegment, TranscriptWord } from "./transcript";

const STORAGE_PREFIX = "tal-till-text:confirmed-words:";

export function confirmedWordsStorageKey(ownerId: string, flowId: string, runId: string, stepId: string): string {
  return `${STORAGE_PREFIX}${ownerId}:${flowId}/${runId}/${stepId}`;
}

/** Someone signed in here: every other person's confirmations go. */
export function keepOnlyConfirmedWordsOf(storage: Pick<Storage, "key" | "length" | "removeItem"> | null, ownerId: string): void {
  removeOtherOwners(storage, STORAGE_PREFIX, ownerId);
}

/**
 * A word's key. Its index in the list does not hold: a word a correction touches leaves the list and moves the ones
 * after it. Its start time stays.
 */
export function wordKey(segmentIndex: number, word: Pick<TranscriptWord, "start" | "word">): string {
  return `${segmentIndex}:${word.start}:${word.word}`;
}

export function toggleConfirmed(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** The uncertain words not yet confirmed, and those that are. */
export function countUncertain(
  segments: readonly TranscriptSegment[],
  confirmed: ReadonlySet<string>,
): { remaining: number; confirmed: number } {
  let remaining = 0;
  let done = 0;
  segments.forEach((s, i) => {
    for (const w of s.words ?? []) {
      if (!w.uncertain) continue;
      if (confirmed.has(wordKey(s.sourceSegmentIndex ?? i, w))) done++;
      else remaining++;
    }
  });
  return { remaining, confirmed: done };
}

export function readConfirmedWords(storage: Pick<Storage, "getItem"> | null, key: string): Set<string> {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((k): k is string => typeof k === "string"));
  } catch {
    return new Set();
  }
}

export function writeConfirmedWords(
  storage: Pick<Storage, "setItem" | "removeItem"> | null,
  key: string,
  set: ReadonlySet<string>,
): void {
  try {
    if (set.size === 0) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify([...set]));
  } catch {
    // A full or refused storage: the confirmation holds for the page.
  }
}
