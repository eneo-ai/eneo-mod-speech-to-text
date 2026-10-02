import assert from "node:assert/strict";
import test from "node:test";

import { clearDraft, isRecord, keepOnlyDraftsOf, readDraft, unstoredDrafts, writeDraft, type DraftStorage } from "./drafts";

/** What a reader of names needs: a list of text. */
const isNames = (value: unknown): value is string[] => Array.isArray(value) && value.every((name) => typeof name === "string");

/** A tab's sessionStorage. */
function tabStorage(): DraftStorage & { data: Map<string, string> } {
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

test("a draft comes back to the same person only, and another person signing in here clears it", () => {
  const storage = tabStorage();
  writeDraft(storage, "user-1", "flow:flow-1", { motesnamn: "KS" });
  assert.deepEqual(readDraft(storage, "user-1", "flow:flow-1", isRecord), { motesnamn: "KS" });
  assert.equal(readDraft(storage, "user-2", "flow:flow-1", isRecord), null, "never another person's");

  writeDraft(storage, "user-2", "flow:flow-1", { motesnamn: "BUN" });
  keepOnlyDraftsOf(storage, "user-2");
  assert.equal(readDraft(storage, "user-1", "flow:flow-1", isRecord), null, "user-1's goes when user-2 signs in");
  assert.deepEqual(readDraft(storage, "user-2", "flow:flow-1", isRecord), { motesnamn: "BUN" });

  clearDraft(storage, "user-2", "flow:flow-1");
  assert.equal(readDraft(storage, "user-2", "flow:flow-1", isRecord), null);
  storage.setItem("not-a-draft", "kept");
  keepOnlyDraftsOf(storage, "user-3");
  assert.equal(storage.getItem("not-a-draft"), "kept", "only drafts are touched");
});

test("a storage the browser refuses, or a draft that does not parse, is no draft and no error", () => {
  const refusing = {
    get length(): number {
      throw new DOMException("denied", "SecurityError");
    },
    key: () => null,
    getItem: () => "{not json",
    setItem: () => {
      throw new DOMException("full", "QuotaExceededError");
    },
    removeItem: () => undefined,
  } satisfies DraftStorage;
  assert.equal(readDraft(refusing, "user-1", "flow:flow-1", isRecord), null);
  assert.equal(writeDraft(refusing, "user-1", "flow:flow-1", { a: 1 }), false);
  keepOnlyDraftsOf(refusing, "user-1");
  assert.equal(readDraft(null, "user-1", "flow:flow-1", isRecord), null);
  clearDraft(refusing, "user-1", "flow:flow-1");
});

test("typed work the storage refused is said to be unkept until it is stored, sent or thrown away, so leaving asks first", () => {
  let refuse = true;
  const storage = tabStorage();
  const flaky = { ...storage, setItem: (key: string, value: string) => {
    if (refuse) throw new DOMException("full", "QuotaExceededError");
    storage.setItem(key, value);
  } };
  let told = 0;
  const stop = unstoredDrafts.subscribe(() => (told += 1));
  try {
    assert.equal(unstoredDrafts.any(), false);
    assert.equal(writeDraft(flaky, "user-1", "flow:flow-1", { motesnamn: "KS" }), false);
    assert.equal(unstoredDrafts.any(), true, "the page asks before leaving");
    assert.equal(writeDraft(null, "user-1", "review:run-1:cp-1", { text: "x" }), false, "no storage keeps nothing either");
    refuse = false;
    assert.equal(writeDraft(flaky, "user-1", "flow:flow-1", { motesnamn: "KS" }), true);
    assert.equal(unstoredDrafts.any(), true, "the review edit is still unkept");
    clearDraft(null, "user-1", "review:run-1:cp-1"); // saved, or thrown away
    assert.equal(unstoredDrafts.any(), false);
    assert.equal(told, 2, "told when it starts and when it ends");
  } finally {
    stop();
  }
});

test("a draft is read only in the shape its reader needs: any other is dropped from the storage and counts as no draft", () => {
  const storage = tabStorage();
  const key = "tal-till-text:draft:user-1:names:run-1:cp-1";
  const stored = (raw: string) => {
    storage.setItem(key, raw);
    return readDraft(storage, "user-1", "names:run-1:cp-1", isNames);
  };
  for (const [what, raw] of [
    ["an object where a list is read", "{}"],
    ["null", "null"],
    ["a list of the wrong things", '[1, {"label": 5}]'],
    ["a number", "3"],
    ["text that is not JSON", "{ not json"],
  ]) {
    assert.equal(stored(raw), null, `${what} is no draft`);
    assert.equal(storage.getItem(key), null, `${what} is removed, not left to fail again`);
  }
  assert.deepEqual(stored('["Anna", "Erik"]'), ["Anna", "Erik"], "a draft of the right shape comes back");
  assert.notEqual(storage.getItem(key), null, "and stays");
  assert.deepEqual(stored("[]"), [], "an empty list is a list");
});

test("a record is an object that is not a list and not null", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  for (const value of [null, undefined, [], [{}], "text", 3, true]) assert.equal(isRecord(value), false);
});
