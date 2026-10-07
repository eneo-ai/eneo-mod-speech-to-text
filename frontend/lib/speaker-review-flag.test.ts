import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

const flag = globalThis as { __SPEAKER_REVIEW__?: boolean };
afterEach(() => {
  delete flag.__SPEAKER_REVIEW__;
});

/** The module as a build leaves it: the flag is a constant that the bundler substitutes, here a global. */
function evaluate(): boolean {
  const path = require.resolve("./speaker-review");
  const kept = require.cache[path];
  delete require.cache[path];
  try {
    return (require("./speaker-review") as typeof import("./speaker-review")).SPEAKER_REVIEW_ENABLED;
  } finally {
    if (kept) require.cache[path] = kept;
  }
}

test("the speaker review is off unless the build switched it on: the unit tests, which have no build constant, are off", () => {
  assert.equal(typeof flag.__SPEAKER_REVIEW__, "undefined");
  assert.equal(evaluate(), false);
});

test("the build constant decides: true is on, false is off", () => {
  flag.__SPEAKER_REVIEW__ = true;
  assert.equal(evaluate(), true);
  flag.__SPEAKER_REVIEW__ = false;
  assert.equal(evaluate(), false);
});
