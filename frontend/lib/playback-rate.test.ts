import assert from "node:assert/strict";
import test from "node:test";

import { playbackRate, RATES, setPlaybackRate } from "./playback-rate";

const memory = () => {
  const data: Record<string, string> = {};
  return { data, getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => void (data[key] = value) };
};

test("the speed a person chose is kept for them alone, and read back as a number", () => {
  const storage = memory();
  assert.equal(playbackRate(storage, "user-1"), 1, "normal speed until one is chosen");
  setPlaybackRate(storage, "user-1", 1.5);
  assert.equal(playbackRate(storage, "user-1"), 1.5);
  assert.equal(playbackRate(storage, "user-2"), 1, "someone else in the same browser keeps theirs");
  for (const rate of RATES) {
    setPlaybackRate(storage, "user-1", rate);
    assert.equal(playbackRate(storage, "user-1"), rate);
  }
});

test("a speed the player does not offer is neither kept nor read back", () => {
  const storage = memory();
  setPlaybackRate(storage, "user-1", 3);
  assert.deepEqual(storage.data, {}, "not kept");
  storage.setItem("tal-till-text:user-1:playback-rate", "16");
  assert.equal(playbackRate(storage, "user-1"), 1, "an unknown value reads as normal speed");
  storage.setItem("tal-till-text:user-1:playback-rate", "snabb");
  assert.equal(playbackRate(storage, "user-1"), 1);
});

test("blocked storage reads as normal speed and never throws", () => {
  const blocked = {
    getItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
  };
  assert.equal(playbackRate(blocked, "user-1"), 1);
  assert.equal(playbackRate(null, "user-1"), 1);
  setPlaybackRate(blocked, "user-1", 1.5);
});
