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

/** A part's chunks read as one run of bytes, without copying them together. */
class Bytes {
  private readonly starts: number[] = [];
  readonly length: number;
  private at = 0;

  constructor(private readonly chunks: readonly Uint8Array[]) {
    let length = 0;
    for (const chunk of chunks) {
      this.starts.push(length);
      length += chunk.length;
    }
    this.length = length;
  }

  /** The chunk holding `position`; reads move forward, so the search starts where the last one ended. */
  private locate(position: number): number {
    if (position < this.starts[this.at]) this.at = 0;
    while (this.at < this.chunks.length - 1 && position >= this.starts[this.at + 1]) this.at += 1;
    return this.at;
  }

  get(position: number): number | undefined {
    if (position < 0 || position >= this.length) return undefined;
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

/**
 * Calls `visit` with the position and value of each SimpleBlock's flags, in order, until it returns false. Only the
 * Segment and a Cluster are entered; every other element is stepped over by its size. "unrecognised" is a file that is
 * not WebM, or an element of unknown size that is neither; bytes that end inside an element end the walk.
 */
function eachBlock(bytes: Bytes, visit: (position: number, flags: number) => boolean): "done" | "unrecognised" {
  const header = element(bytes, 0);
  if (header?.id !== EBML_HEADER || header.size === null) return "unrecognised";
  const segment = element(bytes, header.dataStart + header.size);
  if (segment?.id !== SEGMENT) return "unrecognised";
  for (let at = segment.dataStart; at < bytes.length; ) {
    const child = element(bytes, at);
    if (!child) return "done";
    if (child.id === CLUSTER) {
      at = child.dataStart;
      continue;
    }
    if (child.size === null) return "unrecognised";
    if (child.id === SIMPLE_BLOCK) {
      // Track number, a two-byte timecode, then the flags.
      const track = field(bytes, child.dataStart, false);
      const position = track ? child.dataStart + track.length + 2 : -1;
      const flags = bytes.get(position);
      if (flags === undefined || !visit(position, flags)) return "done";
    }
    at = child.dataStart + child.size;
  }
  return "done";
}

/** The first block's flags, or undefined while the bytes hold none yet; null for a file this does not recognise. */
function firstFlags(chunks: readonly Uint8Array[]): number | null | undefined {
  let first: number | undefined;
  const walked = eachBlock(new Bytes(chunks), (_, flags) => {
    first = flags;
    return false;
  });
  return walked === "unrecognised" ? null : first;
}

/** Sets the keyframe flag on every SimpleBlock of a part's bytes, in place; how many it set. */
export function markKeyframes(chunks: readonly Uint8Array[]): number {
  const bytes = new Bytes(chunks);
  let marked = 0;
  eachBlock(bytes, (position, flags) => {
    if (!(flags & KEYFRAME)) {
      bytes.set(position, flags | KEYFRAME);
      marked += 1;
    }
    return true;
  });
  return marked;
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
 * A WebM audio part's chunks with every block a keyframe, or the chunks as they were: another format, a recorder that
 * flags its blocks, a file this does not recognise, or a chunk that could not be read. Only Safari's parts are read
 * whole; for any other, reading stops at the first block.
 */
export async function withKeyframes(chunks: readonly ChunkData[], mimeType: string): Promise<ChunkData[]> {
  const given = [...chunks];
  if (!/^audio\/webm\b/i.test(mimeType)) return given;
  const read: Uint8Array<ArrayBuffer>[] = [];
  let first: number | null | undefined;
  for (const chunk of chunks) {
    const bytes = await copyOf(chunk);
    if (!bytes) return given;
    read.push(bytes);
    if (first === undefined) {
      first = firstFlags(read);
      if (first === null || (first !== undefined && first & KEYFRAME)) return given;
    }
  }
  return markKeyframes(read) > 0 ? read : given;
}
