import assert from "node:assert/strict";
import test from "node:test";

import { letterKeysOn, setLetterKeysOn } from "./letter-keys";

test("K, J and L are on until a person turns them off, and their choice is kept for them alone", () => {
  const data: Record<string, string> = {};
  const storage = { getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => void (data[key] = value) };
  assert.equal(letterKeysOn(storage, "user-1"), true, "on by default");
  assert.equal(letterKeysOn(null, "user-1"), true, "on where the page may not use storage");

  setLetterKeysOn(storage, "user-1", false);
  assert.equal(letterKeysOn(storage, "user-1"), false, "off, kept");
  assert.equal(letterKeysOn(storage, "user-2"), true, "someone else in the same browser keeps theirs");

  setLetterKeysOn(storage, "user-1", true);
  assert.equal(letterKeysOn(storage, "user-1"), true, "on again");
});

test("blocked storage leaves the keys on and never throws", () => {
  const blocked = {
    getItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
  };
  assert.equal(letterKeysOn(blocked, "user-1"), true);
  setLetterKeysOn(blocked, "user-1", false);
});
