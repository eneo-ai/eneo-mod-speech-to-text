/**
 * Several files as one zip, so that one press saves them all: a browser saves one download a press and may block the
 * ones after it. Stored as they are (audio does not shrink), and assembled from the files' own Blobs: each file is
 * read once for its checksum, a slice at a time, so a long part is never held whole in the page.
 */

export interface NamedBlob {
  filename: string;
  blob: Blob;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** The CRC-32 of `bytes`, going on from the running value `from` (a slice after the ones before it). */
export function crc32(bytes: Uint8Array, from = 0): number {
  let crc = (from ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const SLICE = 1024 * 1024;

export async function blobCrc32(blob: Blob, slice = SLICE): Promise<number> {
  let crc = 0;
  for (let at = 0; at < blob.size; at += slice) crc = crc32(new Uint8Array(await blob.slice(at, at + slice).arrayBuffer()), crc);
  return crc;
}

// General purpose flag 11: the names are UTF-8 ("Nämndmöte").
const UTF8_NAMES = 0x0800;
const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;

export async function zipFiles(files: readonly NamedBlob[], at = new Date()): Promise<Blob> {
  // MS-DOS time and date, as the zip format keeps them.
  const time = (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1);
  const date = ((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate();
  const encoder = new TextEncoder();
  const body: BlobPart[] = [];
  const directory: DataView<ArrayBuffer>[] = [];
  let offset = 0;
  for (const file of files) {
    // A name is never a path: a separator in it would place the file outside where the zip is unpacked.
    const name = encoder.encode(file.filename.replace(/[\u0000-\u001f\u007f\\/]+/g, "-"));
    const crc = await blobCrc32(file.blob);
    // The fields a file's local header and its directory entry share, in the same order: from "version needed".
    const shared = (view: DataView, from: number) => {
      view.setUint16(from, 20, true);
      view.setUint16(from + 2, UTF8_NAMES, true);
      view.setUint16(from + 4, 0, true); // stored
      view.setUint16(from + 6, time, true);
      view.setUint16(from + 8, date, true);
      view.setUint32(from + 10, crc, true);
      view.setUint32(from + 14, file.blob.size, true);
      view.setUint32(from + 18, file.blob.size, true);
      view.setUint16(from + 22, name.length, true);
    };
    const local = new DataView(new ArrayBuffer(30 + name.length));
    local.setUint32(0, LOCAL, true);
    shared(local, 4);
    new Uint8Array(local.buffer).set(name, 30);
    const entry = new DataView(new ArrayBuffer(46 + name.length));
    entry.setUint32(0, CENTRAL, true);
    entry.setUint16(4, 20, true); // made by
    shared(entry, 6);
    entry.setUint32(42, offset, true);
    new Uint8Array(entry.buffer).set(name, 46);
    body.push(local, file.blob);
    directory.push(entry);
    offset += local.byteLength + file.blob.size;
  }
  const size = directory.reduce((sum, entry) => sum + entry.byteLength, 0);
  // ponytail: no Zip64; a recording's parts are far below 4 GiB together. Zip64 records if they ever are not.
  if (offset + size > 0xffffffff || files.length > 0xffff) throw new RangeError("Too large for a zip without Zip64.");
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, END, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...body, ...directory, end], { type: "application/zip" });
}
