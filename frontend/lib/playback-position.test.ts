import assert from "node:assert/strict";
import test from "node:test";

import { Playback } from "./playback";
import { rememberPosition } from "./playback-position";

const PARTS = [
  { url: "/a", durationMs: 4_000 },
  { url: "/b", durationMs: 2_000 },
];

/** A browser's localStorage, as far as the remembered positions use it. */
function storage() {
  const items = new Map<string, string>();
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) };
}

const kept = (store: ReturnType<typeof storage>) => JSON.parse(store.getItem("tal-till-text:playback-positions") ?? "{}");

test("a run's recording goes on where it was left: kept as it plays, put back when the run is opened again, gone at its end", () => {
  const store = storage();
  let now = 0;
  const first = new Playback(PARTS);
  const stop = rememberPosition(first, "run-1", store, () => now);
  assert.deepEqual(kept(store), {}, "opening a run keeps nothing");

  first.onPlay();
  first.seek(0, 1_000);
  assert.deepEqual(kept(store)["run-1"], { part: 0, withinMs: 1_000 });
  now = 2_000;
  first.seek(0, 3_000);
  assert.deepEqual(kept(store)["run-1"], { part: 0, withinMs: 1_000 }, "while it plays, a few seconds apart");
  first.onPause();
  assert.deepEqual(kept(store)["run-1"], { part: 0, withinMs: 3_000 }, "a pause is kept at once");
  first.seek(1, 500);
  stop();

  const again = new Playback(PARTS);
  rememberPosition(again, "run-1", store, () => now);
  const { part, withinMs, started } = again.getSnapshot();
  assert.deepEqual({ part, withinMs, started }, { part: 1, withinMs: 500, started: false }, "where it was, not yet played");
  again.seek(1, 2_000);
  assert.equal(kept(store)["run-1"], undefined, "played to its end, it starts from the beginning next time");
});
