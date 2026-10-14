/**
 * The one owner of where a person left off listening to a run, kept in this browser (localStorage) for the latest
 * runs: opening the run again puts the player there, without playing. Written while it plays, a few seconds apart,
 * and at once on a pause or a move; forgotten once the recording has played to its end, or is back at its start.
 */

import type { Playback } from "./playback";

const KEY = "tal-till-text:playback-positions";
/** Runs remembered at most; the one listened to longest ago goes first. */
const KEPT = 50;
/** While it plays, at most one write this often. */
const EVERY_MS = 5_000;

type Position = { part: number; withinMs: number };
type PositionStorage = Pick<Storage, "getItem" | "setItem">;

const isPosition = (value: unknown): value is Position =>
  typeof value === "object" &&
  value !== null &&
  Number.isInteger((value as Position).part) &&
  (value as Position).part >= 0 &&
  Number.isFinite((value as Position).withinMs) &&
  (value as Position).withinMs >= 0;

function read(storage: PositionStorage | null): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(storage?.getItem(KEY) ?? "{}");
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Keeps `position` for the run as its newest, or forgets the run when it is null. */
function write(storage: PositionStorage | null, runId: string, position: Position | null): void {
  const positions = read(storage);
  delete positions[runId];
  if (position) positions[runId] = position;
  try {
    storage?.setItem(KEY, JSON.stringify(Object.fromEntries(Object.entries(positions).slice(-KEPT))));
  } catch {
    // A full or refused storage: the place is not remembered, and playback goes on as it is.
  }
}

/** Puts `playback` where the run was left, and keeps where it goes from there; returns what stops keeping it. */
export function rememberPosition(playback: Playback, runId: string, storage: PositionStorage | null, now: () => number = Date.now): () => void {
  const saved = read(storage)[runId];
  if (isPosition(saved)) playback.resumeAt(saved.part, saved.withinMs);
  // What was last written: a position's key, or "" for forgotten; nothing yet at first, so a first end still forgets.
  let last: string | null = null;
  let lastAt = Number.NEGATIVE_INFINITY;
  return playback.subscribe(() => {
    const { started, playing, atEnd, part, withinMs } = playback.getSnapshot();
    if (!started) return;
    const position = atEnd || (part === 0 && withinMs === 0) ? null : { part, withinMs: Math.round(withinMs) };
    const key = position ? `${position.part}:${position.withinMs}` : "";
    if (key === last || (position && playing && now() - lastAt < EVERY_MS)) return;
    write(storage, runId, position);
    last = key;
    // Only a kept place starts the wait before the next one.
    lastAt = position ? now() : Number.NEGATIVE_INFINITY;
  });
}
