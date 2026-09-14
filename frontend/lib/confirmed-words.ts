// Bekräftade osäkra ord.
//
// Eneos korrigeringsmodell (se transcript-corrections.ts) rymmer bara
// textersättningar och talarbyten, så "granskaren har lyssnat och ordet
// stämmer" kan inte sparas hos Eneo. Bekräftelserna lagras i stället lokalt
// i webbläsaren, per transkriberingssteg, och används enbart för att dämpa
// markeringen i spelaren.

import type { TranscriptSegment, TranscriptWord } from "./transcript";

const STORAGE_PREFIX = "stt:confirmed-words:";

export function confirmedWordsStorageKey(flowId: string, runId: string, stepId: string): string {
  return `${STORAGE_PREFIX}${flowId}/${runId}/${stepId}`;
}

/**
 * Stabil nyckel för ett ord. Ordindex duger inte: ord som berörs av en
 * rättning försvinner ur listan och flyttar efterföljande index. Starttiden
 * följer däremot med oförändrad.
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

/** Osäkra ord som ännu inte bekräftats respektive redan bekräftats. */
export function countUncertain(
  segments: readonly TranscriptSegment[],
  confirmed: ReadonlySet<string>,
): { remaining: number; confirmed: number } {
  let remaining = 0;
  let done = 0;
  segments.forEach((s, i) => {
    for (const w of s.words ?? []) {
      if (!w.uncertain) continue;
      if (confirmed.has(wordKey(i, w))) done++;
      else remaining++;
    }
  });
  return { remaining, confirmed: done };
}

export function readConfirmedWords(storage: Pick<Storage, "getItem">, key: string): Set<string> {
  try {
    const raw = storage.getItem(key);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((k): k is string => typeof k === "string"));
  } catch {
    return new Set();
  }
}

export function writeConfirmedWords(
  storage: Pick<Storage, "setItem" | "removeItem">,
  key: string,
  set: ReadonlySet<string>,
): void {
  try {
    if (set.size === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify([...set]));
  } catch {
    // Privat läge eller fullt lagringsutrymme: bekräftelsen gäller sessionen ut.
  }
}
