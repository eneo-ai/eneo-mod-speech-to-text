import assert from "node:assert/strict";
import test from "node:test";

import { clearDraft, keepOnlyDraftsOf, readDraft, writeDraft, type DraftStorage } from "./drafts";

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
  assert.deepEqual(readDraft(storage, "user-1", "flow:flow-1"), { motesnamn: "KS" });
  assert.equal(readDraft(storage, "user-2", "flow:flow-1"), null, "never another person's");

  writeDraft(storage, "user-2", "flow:flow-1", { motesnamn: "BUN" });
  keepOnlyDraftsOf(storage, "user-2");
  assert.equal(readDraft(storage, "user-1", "flow:flow-1"), null, "user-1's goes when user-2 signs in");
  assert.deepEqual(readDraft(storage, "user-2", "flow:flow-1"), { motesnamn: "BUN" });

  clearDraft(storage, "user-2", "flow:flow-1");
  assert.equal(readDraft(storage, "user-2", "flow:flow-1"), null);
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
  assert.equal(readDraft(refusing, "user-1", "flow:flow-1"), null);
  writeDraft(refusing, "user-1", "flow:flow-1", { a: 1 });
  keepOnlyDraftsOf(refusing, "user-1");
  assert.equal(readDraft(null, "user-1", "flow:flow-1"), null);
});
