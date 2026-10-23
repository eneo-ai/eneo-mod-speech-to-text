/** Reading a recording's WebM: its EBML elements, in one chunk or across several (webm-duration.ts, webm-keyframes.ts). */

export const EBML_HEADER = 0x1a45dfa3;
export const SEGMENT = 0x18538067;
/** A chunk is a few seconds of audio; one whose bytes do not come in this long is left as it was. */
const READ_MS = 2_000;

/** A part's chunks read as one run of bytes, without copying them together; the first starts at `offset` in the part. */
export class Bytes {
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
export function field(bytes: Bytes, position: number, id: boolean): { value: number; length: number; unknown: boolean } | null {
  const first = bytes.get(position);
  if (!first) return null;
  const length = Math.clz32(first) - 23;
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

export interface Element {
  id: number;
  sizeStart: number;
  sizeLength: number;
  dataStart: number;
  /** null: unknown size, the element runs to the end of its parent. */
  size: number | null;
}

/** The element at `position`, or null when its id and size are cut off or malformed. */
export function element(bytes: Bytes, position: number): Element | null {
  const id = field(bytes, position, true);
  const sizeStart = position + (id?.length ?? 0);
  const size = id && field(bytes, sizeStart, false);
  if (!id || !size) return null;
  return { id: id.value, sizeStart, sizeLength: size.length, dataStart: sizeStart + size.length, size: size.unknown ? null : size.value };
}

/** A Blob's bytes, or null when they cannot be read or do not come in READ_MS. */
export async function bytesOf(blob: Blob): Promise<Uint8Array<ArrayBuffer> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    blob.arrayBuffer().then((buffer) => new Uint8Array(buffer), () => null),
    new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), READ_MS))),
  ]).finally(() => clearTimeout(timer));
}
