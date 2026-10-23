/**
 * Safari's recorder writes WebM whose audio blocks do not carry the keyframe flag. Every Opus packet decodes on its own,
 * so each block is one a player may start from, but Chromium's demuxer (FFmpeg) only starts at a flagged block, and a
 * recorder's WebM has no Cues either: Chrome and Edge cannot seek in such a file, not even to its start, and play
 * nothing (measured 2026-10-13 on a Safari recording). This sets the flag on every SimpleBlock of a part, in place:
 * one byte each, so nothing after it moves. A part whose first block already has the flag (Chrome's, Firefox's) is
 * left as it was, and so is one this does not recognise.
 */

type ChunkData = Blob | ArrayBuffer | Uint8Array<ArrayBuffer>;

const EBML_HEADER = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const CLUSTER = 0x1f43b675;
const SIMPLE_BLOCK = 0xa3;
const KEYFRAME = 0x80;
/** A chunk is a few seconds of audio; one that is not read in this long is left alone, as the duration's patch does. */
const CHUNK_READ_MS = 2_000;

/** A part's chunks read as one run of bytes, without copying them together; the first starts at `offset` in the part. */
class Bytes {
  private readonly starts: number[] = [];
  /** Where in the part these bytes end. */
  readonly end: number;
  private at = 0;

  constructor(
    private readonly chunks: readonly Uint8Array[],
    private readonly offset = 0,
  ) {
    let length = offset;
    for (const chunk of chunks) {
      this.starts.push(length);
      length += chunk.length;
    }
    this.end = length;
  }

  /** The chunk holding `position`; reads move forward, so the search starts where the last one ended. */
  private locate(position: number): number {
    if (position < this.starts[this.at]) this.at = 0;
    while (this.at < this.chunks.length - 1 && position >= this.starts[this.at + 1]) this.at += 1;
    return this.at;
  }

  get(position: number): number | undefined {
    if (position < this.offset || position >= this.end) return undefined;
    const i = this.locate(position);
    return this.chunks[i][position - this.starts[i]];
  }

  set(position: number, value: number): void {
    const i = this.locate(position);
    this.chunks[i][position - this.starts[i]] = value;
  }
}

/** An EBML variable-length field at `position`: its value (with the length marker for an id) and its length. */
function field(bytes: Bytes, position: number, id: boolean): { value: number; length: number; unknown: boolean } | null {
  const first = bytes.get(position);
  if (!first) return null;
  const length = Math.clz32(first) - 23;
  if (length > 8) return null;
  let value = id ? first : first & (0xff >> length);
  let unknown = !id && value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const next = bytes.get(position + i);
    if (next === undefined) return null;
    value = value * 256 + next;
    unknown &&= next === 0xff;
  }
  return { value, length, unknown };
}

function element(bytes: Bytes, position: number): { id: number; dataStart: number; size: number | null } | null {
  const id = field(bytes, position, true);
  const size = id && field(bytes, position + id.length, false);
  if (!id || !size) return null;
  return { id: id.value, dataStart: position + id.length + size.length, size: size.unknown ? null : size.value };
}

/** How far a walk of a part's blocks has come: the element it reads next, in the part's bytes, and what it reads it as. */
type Walk = { at: number; phase: "header" | "segment" | "blocks" | "done" | "unrecognised" };
/** The most an element's id and size, and a block's track, timecode and flags, take from where the element starts. */
const ELEMENT_HEAD = 24;

/**
 * Calls `visit` with the position and value of each SimpleBlock's flags, in order, until it returns false. Only the
 * Segment and a Cluster are entered; every other element is stepped over by its size. "unrecognised" is a file that is
 * not WebM, or an element of unknown size that is neither; bytes that end inside an element end the walk ("done"). With
 * `more` bytes to come the walk stops before an element its bytes may not hold whole, and `walk` goes on from there.
 */
function walkBlocks(bytes: Bytes, walk: Walk, visit: (position: number, flags: number) => boolean, more = false): void {
  const room = (position: number) => !more || bytes.end - position >= ELEMENT_HEAD;
  if (walk.phase === "header") {
    if (!room(0)) return;
    const header = element(bytes, 0);
    if (header?.id !== EBML_HEADER || header.size === null) return void (walk.phase = "unrecognised");
    Object.assign(walk, { at: header.dataStart + header.size, phase: "segment" });
  }
  if (walk.phase === "segment") {
    if (!room(walk.at)) return;
    const segment = element(bytes, walk.at);
    if (segment?.id !== SEGMENT) return void (walk.phase = "unrecognised");
    Object.assign(walk, { at: segment.dataStart, phase: "blocks" });
  }
  while (walk.phase === "blocks" && walk.at < bytes.end) {
    if (!room(walk.at)) return;
    const child = element(bytes, walk.at);
    if (!child) return void (walk.phase = "done");
    if (child.id === CLUSTER) {
      walk.at = child.dataStart;
      continue;
    }
    if (child.size === null) return void (walk.phase = "unrecognised");
    if (child.id === SIMPLE_BLOCK) {
      // Track number, a two-byte timecode, then the flags.
      const track = field(bytes, child.dataStart, false);
      const position = track ? child.dataStart + track.length + 2 : -1;
      const flags = bytes.get(position);
      if (flags === undefined || !visit(position, flags)) return void (walk.phase = "done");
    }
    walk.at = child.dataStart + child.size;
  }
  if (!more && walk.phase !== "unrecognised") walk.phase = "done";
}

/**
 * The first block's flags, or undefined while the bytes hold none yet; null for a file this does not recognise. With
 * `more` bytes to come, bytes that end inside an element hold no block yet.
 */
function firstFlags(chunks: readonly Uint8Array[], more = false): number | null | undefined {
  let first: number | undefined;
  const walk: Walk = { at: 0, phase: "header" };
  walkBlocks(
    new Bytes(chunks),
    walk,
    (_, flags) => {
      first = flags;
      return false;
    },
    more,
  );
  return walk.phase === "unrecognised" ? null : first;
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

/** A chunk's bytes as a copy this may change, or null when they do not come in time. */
async function copyOf(chunk: ChunkData): Promise<Uint8Array<ArrayBuffer> | null> {
  if (chunk instanceof Uint8Array) return chunk.slice();
  if (!(chunk instanceof Blob)) return new Uint8Array(chunk.slice(0));
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    chunk.arrayBuffer().then((buffer) => new Uint8Array(buffer), () => null),
    new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), CHUNK_READ_MS))),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Whether a part that starts with `chunks` needs its blocks marked: true when its first block lacks the flag (Safari's
 * WebM), false when it has it or is not WebM this recognises (or a chunk could not be read), undefined while these chunks
 * hold no block yet. Nothing is copied to look.
 */
async function needsKeyframes(chunks: readonly ChunkData[], mimeType: string): Promise<boolean | undefined> {
  if (!/^audio\/webm\b/i.test(mimeType)) return false;
  const read: Uint8Array[] = [];
  for (const chunk of chunks) {
    const bytes = chunk instanceof Blob ? await copyOf(chunk) : chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    if (!bytes) return false;
    read.push(bytes);
    const first = firstFlags(read, true);
    if (first === null) return false;
    if (first !== undefined) return !(first & KEYFRAME);
  }
  return undefined;
}

/**
 * A part's chunks as they are read, a batch at a time, every block a keyframe where the part needs it (Safari's WebM).
 * Each call takes the next chunks and gives back, in order, those that are done; with `last` it gives back the rest. A
 * part that needs nothing goes through as it was, its very chunks; one that does goes as marked copies, and the chunks
 * given are never changed. It holds only the chunks not yet known to be done: until the first block, and the few an
 * element still to be read reaches into. A chunk that cannot be read in time ends the marking: the chunks before it go
 * marked, it and those after it as they were.
 */
export function keyframeMarker(mimeType: string): (chunks: readonly ChunkData[], last?: boolean) => Promise<ChunkData[]> {
  let needs: boolean | undefined;
  let waiting: ChunkData[] = [];
  const walk: Walk = { at: 0, phase: "header" };
  let held: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  const over = () => walk.phase === "done" || walk.phase === "unrecognised";
  /** The marked copies the walk has passed, or all of them. */
  const done = (all: boolean) => {
    let passed = 0;
    while (passed < held.length && (all || over() || offset + held[passed].length <= walk.at)) offset += held[passed++].length;
    return held.splice(0, passed);
  };
  return async (chunks, last = false) => {
    if (needs === undefined) {
      waiting.push(...chunks);
      needs = await needsKeyframes(waiting, mimeType);
      if (needs === undefined && !last) return [];
      [chunks, waiting] = [waiting, []];
    }
    if (!needs) return [...chunks];
    for (const [i, chunk] of chunks.entries()) {
      const copy = over() ? null : await copyOf(chunk);
      if (!copy) {
        marker(new Bytes(held, offset), walk);
        walk.phase = "done";
        return [...done(true), ...chunks.slice(i)];
      }
      held.push(copy);
    }
    marker(new Bytes(held, offset), walk, !last);
    return done(last);
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
