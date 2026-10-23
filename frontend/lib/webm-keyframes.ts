/**
 * Safari's recorder writes WebM whose audio blocks do not carry the keyframe flag. Every Opus packet decodes on its own,
 * so each block is one a player may start from, but Chromium's demuxer (FFmpeg) only starts at a flagged block, and a
 * recorder's WebM has no Cues either: Chrome and Edge cannot seek in such a file, not even to its start, and play
 * nothing (measured 2026-10-13 on a Safari recording). This sets the flag on every SimpleBlock of a part, in place:
 * one byte each, so nothing after it moves. A part whose first block already has the flag (Chrome's, Firefox's) is
 * left as it was, and so is one this does not recognise.
 */

import { Bytes, bytesOf, EBML_HEADER, element, field, SEGMENT } from "./ebml";

type ChunkData = Blob | ArrayBuffer | Uint8Array<ArrayBuffer>;

const CLUSTER = 0x1f43b675;
const SIMPLE_BLOCK = 0xa3;
const KEYFRAME = 0x80;

/** How far a walk of a part's blocks has come: the element it reads next, in the part's bytes, and what it reads it as. */
type Walk = { at: number; phase: "header" | "segment" | "blocks" | "done" };
/** The most an element's id and size, and a block's track, timecode and flags, take from where the element starts. */
const ELEMENT_HEAD = 24;

/**
 * Calls `visit` with the position and value of each SimpleBlock's flags, in order, until it returns false. The EBML
 * header is stepped over, and the Segment and a Cluster are entered; every other element is stepped over by its size.
 * The walk is "done" at the end of the bytes, and where they are not WebM, hold an element of unknown size that is
 * neither, or end inside an element. With `more` bytes to come the walk stops before an element its bytes may not hold
 * whole, and `walk` goes on from there.
 */
function walkBlocks(bytes: Bytes, walk: Walk, visit: (position: number, flags: number) => boolean, more = false): void {
  while (walk.phase !== "done" && walk.at < bytes.end) {
    if (more && bytes.end - walk.at < ELEMENT_HEAD) return;
    const { phase } = walk;
    const child = element(bytes, walk.at);
    // The file starts with the EBML header and then the Segment.
    if (!child || (phase === "header" && child.id !== EBML_HEADER) || (phase === "segment" && child.id !== SEGMENT)) break;
    walk.phase = phase === "header" ? "segment" : "blocks";
    if (phase === "segment" || child.id === CLUSTER) {
      walk.at = child.dataStart;
      continue;
    }
    if (child.size === null) break;
    if (child.id === SIMPLE_BLOCK) {
      // Track number, a two-byte timecode, then the flags.
      const track = field(bytes, child.dataStart, false);
      const position = track ? child.dataStart + track.length + 2 : -1;
      const flags = bytes.get(position);
      if (flags === undefined || !visit(position, flags)) break;
    }
    walk.at = child.dataStart + child.size;
  }
  if (!more || walk.at < bytes.end) walk.phase = "done";
}

/** Sets the keyframe flag on each SimpleBlock `bytes` hold that lacks it; how many it set. */
function marker(bytes: Bytes, walk: Walk, more = false): number {
  let marked = 0;
  walkBlocks(
    bytes,
    walk,
    (position, flags) => {
      if (!(flags & KEYFRAME)) {
        bytes.set(position, flags | KEYFRAME);
        marked += 1;
      }
      return true;
    },
    more,
  );
  return marked;
}

/** Sets the keyframe flag on every SimpleBlock of a part's bytes, in place; how many it set. */
export function markKeyframes(chunks: readonly Uint8Array[]): number {
  return marker(new Bytes(chunks), { at: 0, phase: "header" });
}

/** A chunk's bytes as a copy this may change, or null when they do not come in time (bytesOf). */
async function copyOf(chunk: ChunkData): Promise<Uint8Array<ArrayBuffer> | null> {
  if (chunk instanceof Uint8Array) return chunk.slice();
  return chunk instanceof Blob ? bytesOf(chunk) : new Uint8Array(chunk.slice(0));
}

/**
 * A part's chunks as they are read, a batch at a time, every block a keyframe where the part needs it: its first block
 * lacks the flag (Safari's WebM). Each call takes the next chunks and gives back, in order, those that are done; with
 * `last` it gives back the rest. A part that needs nothing (its first block flagged, another format, a file this does
 * not recognise, a chunk unread before its first block) goes through as it was, its very chunks; one that does goes as
 * marked copies, and the chunks given are never changed. It holds only the chunks not yet known to be done: until the
 * first block, read a chunk at a time, and the few an element still to be read reaches into. A chunk that cannot be
 * read in time ends the marking: the chunks before it go marked, it and those after it as they were.
 */
export function keyframeMarker(mimeType: string): (chunks: readonly ChunkData[], last?: boolean) => Promise<ChunkData[]> {
  // Undefined until the walk reaches the first block.
  let needs = /^audio\/webm\b/i.test(mimeType) ? undefined : false;
  // The chunks as given, until `needs` is known.
  let given: ChunkData[] = [];
  const walk: Walk = { at: 0, phase: "header" };
  const held: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  /** The marked copies the walk has passed, or all of them. */
  const done = (all: boolean) => {
    let passed = 0;
    while (passed < held.length && (all || walk.phase === "done" || offset + held[passed].length <= walk.at)) offset += held[passed++].length;
    return held.splice(0, passed);
  };
  const mark = (more = false) => {
    const bytes = new Bytes(held, offset);
    walkBlocks(
      bytes,
      walk,
      (position, flags) => {
        needs ??= !(flags & KEYFRAME);
        if (needs) bytes.set(position, flags | KEYFRAME);
        return needs;
      },
      more,
    );
  };
  return async (chunks, last = false) => {
    if (needs === false) return [...chunks];
    if (needs === undefined) given.push(...chunks);
    let rest: readonly ChunkData[] = [];
    for (const [i, chunk] of chunks.entries()) {
      const copy = walk.phase === "done" ? null : await copyOf(chunk);
      if (!copy) {
        rest = chunks.slice(i);
        break;
      }
      held.push(copy);
      // Looked at before the next is read: a part whose first block says it needs nothing is read no further.
      if (needs === undefined) mark(true);
    }
    const stopped = rest.length > 0;
    mark(!last && !stopped);
    if (stopped) walk.phase = "done";
    // No first block yet: wait for more chunks, unless there are none or the walk has ended without one.
    if (needs === undefined && !last && walk.phase !== "done") return [];
    const asGiven = given;
    given = [];
    if (!needs) {
      needs = false;
      held.length = 0;
      return asGiven;
    }
    return stopped ? [...done(true), ...rest] : done(last);
  };
}

/**
 * A WebM audio part's chunks with every block a keyframe, or the chunks as they were: another format, a recorder that
 * flags its blocks, a file this does not recognise, or a chunk that could not be read. Only Safari's parts are read
 * whole; for any other, reading stops at the first block.
 */
export function withKeyframes(chunks: readonly ChunkData[], mimeType: string): Promise<ChunkData[]> {
  return keyframeMarker(mimeType)(chunks, true);
}
