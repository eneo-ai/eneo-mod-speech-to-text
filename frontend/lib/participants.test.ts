import assert from "node:assert/strict";
import test from "node:test";

import { addNames, recentNames, rememberNames, splitNames, takeNames } from "./participants";

function memoryStorage() {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => void (data[key] = value),
  };
}

test("pasted names split on commas, semicolons and line breaks", () => {
  assert.deepEqual(splitNames("Anna Berg, Erik Lund;Sara Holm\n\nOla  ,"), [
    "Anna Berg",
    "Erik Lund",
    "Sara Holm",
    "Ola",
  ]);
  assert.deepEqual(splitNames("  "), []);
});

test("typing a separator completes the names before it and keeps the rest in the input", () => {
  assert.deepEqual(takeNames("Anna Berg,"), { names: ["Anna Berg"], rest: "" });
  assert.deepEqual(takeNames("Anna Berg; Erik"), { names: ["Anna Berg"], rest: " Erik" });
  assert.deepEqual(takeNames("Anna"), { names: [], rest: "Anna" });
});

test("a name already among the chips is not added twice, whatever its case", () => {
  assert.deepEqual(addNames(["Anna Berg"], ["anna berg", "Erik Lund", "Erik Lund"]), ["Anna Berg", "Erik Lund"]);
});

test("recent names are this user's own, most recent first, and a broken store never breaks typing", () => {
  const storage = memoryStorage();
  rememberNames(storage, "user-1", ["Anna Berg"]);
  rememberNames(storage, "user-1", ["Erik Lund", "Sara Holm"]);
  rememberNames(storage, "user-1", ["anna berg"]);
  assert.deepEqual(recentNames(storage, "user-1"), ["anna berg", "Sara Holm", "Erik Lund"]);
  assert.deepEqual(recentNames(storage, "user-2"), [], "a shared device keeps each person's names apart");

  for (let i = 0; i < 40; i += 1) rememberNames(storage, "user-1", [`Person ${i}`]);
  assert.equal(recentNames(storage, "user-1").length, 30);
  assert.equal(recentNames(storage, "user-1")[0], "Person 39");

  storage.data["tal-till-text:user-1:recent-names"] = "not json";
  assert.deepEqual(recentNames(storage, "user-1"), []);
  const throwing = {
    getItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("full", "QuotaExceededError");
    },
  };
  assert.deepEqual(recentNames(throwing, "user-1"), []);
  rememberNames(throwing, "user-1", ["Anna"]);
});
