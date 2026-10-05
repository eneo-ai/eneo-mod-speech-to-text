import assert from "node:assert/strict";
import { test } from "node:test";
import {
  confirmedWordsStorageKey,
  countUncertain,
  keepOnlyConfirmedWordsOf,
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

test("the key tells segments apart, also for identical words", () => {
  assert.notEqual(wordKey(0, segments[0].words![0]), wordKey(1, segments[1].words![0]));
});

test("counts the confirmed and the remaining uncertain words", () => {
  const none = countUncertain(segments, new Set());
  assert.deepEqual(none, { remaining: 2, confirmed: 0 });
  const one = countUncertain(segments, new Set([wordKey(1, segments[1].words![0])]));
  assert.deepEqual(one, { remaining: 1, confirmed: 1 });
});

test("toggling adds and removes without changing the original", () => {
  const base = new Set<string>();
  const added = toggleConfirmed(base, "a");
  assert.equal(base.size, 0);
  assert.ok(added.has("a"));
  assert.equal(toggleConfirmed(added, "a").size, 0);
});

test("storage round-trips and survives garbage", () => {
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

function localStorageOf() {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

test("confirmations are kept per person, in the module's own namespace", () => {
  const mine = confirmedWordsStorageKey("user-1", "flow", "run", "step");
  assert.ok(mine.startsWith("tal-till-text:confirmed-words:user-1:"), mine);
  assert.notEqual(mine, confirmedWordsStorageKey("user-2", "flow", "run", "step"));
});

test("another person signing in clears the confirmations of the one before, and touches nothing else", () => {
  const storage = localStorageOf();
  const before = confirmedWordsStorageKey("user-1", "flow", "run", "step");
  const after = confirmedWordsStorageKey("user-2", "flow", "run", "step");
  writeConfirmedWords(storage, before, new Set(["0:0:Hej"]));
  writeConfirmedWords(storage, after, new Set(["1:1:du"]));
  storage.setItem("theme", "dark");
  keepOnlyConfirmedWordsOf(storage, "user-2");
  assert.equal(storage.getItem(before), null, "user-1's confirmations go");
  assert.ok(storage.getItem(after), "user-2's stay");
  assert.equal(storage.getItem("theme"), "dark", "only confirmations are touched");
  keepOnlyConfirmedWordsOf(null, "user-2");
});
