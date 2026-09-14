import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countUncertain,
  readConfirmedWords,
  toggleConfirmed,
  wordKey,
  writeConfirmedWords,
} from "./confirmed-words";
import type { TranscriptSegment } from "./transcript";

const word = (w: string, start: number, uncertain: boolean) => ({
  word: w,
  start,
  end: start + 0.3,
  probability: uncertain ? 0 : 0.9,
  charStart: 0,
  charEnd: w.length,
  uncertain,
});

const segments: TranscriptSegment[] = [
  { fileIndex: 0, start: 0, end: 1, speaker: "SPEAKER_00", text: "Hej du", words: [word("Hej", 0, true), word("du", 0.5, false)] },
  { fileIndex: 0, start: 1, end: 2, speaker: "SPEAKER_01", text: "Hej", words: [word("Hej", 1, true)] },
];

test("nyckeln skiljer på segment även för identiska ord", () => {
  assert.notEqual(wordKey(0, segments[0].words![0]), wordKey(1, segments[1].words![0]));
});

test("räknar bekräftade och återstående osäkra ord", () => {
  const none = countUncertain(segments, new Set());
  assert.deepEqual(none, { remaining: 2, confirmed: 0 });
  const one = countUncertain(segments, new Set([wordKey(1, segments[1].words![0])]));
  assert.deepEqual(one, { remaining: 1, confirmed: 1 });
});

test("toggle lägger till och tar bort utan att ändra originalet", () => {
  const base = new Set<string>();
  const added = toggleConfirmed(base, "a");
  assert.equal(base.size, 0);
  assert.ok(added.has("a"));
  assert.equal(toggleConfirmed(added, "a").size, 0);
});

test("lagringen är rundtursäker och tål skräp", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  writeConfirmedWords(storage, "k", new Set(["a", "b"]));
  assert.deepEqual([...readConfirmedWords(storage, "k")].sort(), ["a", "b"]);
  writeConfirmedWords(storage, "k", new Set());
  assert.equal(store.has("k"), false);
  store.set("k", "{not json");
  assert.equal(readConfirmedWords(storage, "k").size, 0);
  store.set("k", JSON.stringify([1, "x"]));
  assert.deepEqual([...readConfirmedWords(storage, "k")], ["x"]);
});
