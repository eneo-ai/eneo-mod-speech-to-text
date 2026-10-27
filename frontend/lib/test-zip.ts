/**
 * What a zip holds, as Python's zipfile reads it once it has tested every file's checksum: each file's name and bytes,
 * in order. A reader of its own, so that a zip the app writes is checked by more than the app's idea of the format.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const READ = `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    assert z.testzip() is None, "a checksum does not match"
    print(json.dumps([[i.filename, z.read(i).hex()] for i in z.infolist()]))
`;

export async function unzipped(blob: Blob | Buffer): Promise<Array<[string, Buffer]>> {
  const dir = mkdtempSync(join(tmpdir(), "zip-"));
  const path = join(dir, "saved.zip");
  try {
    writeFileSync(path, blob instanceof Blob ? new Uint8Array(await blob.arrayBuffer()) : blob);
    const files: Array<[string, string]> = JSON.parse(execFileSync("python3", ["-I", "-c", READ, path], { encoding: "utf8", maxBuffer: 1 << 30 }));
    return files.map(([name, hex]) => [name, Buffer.from(hex, "hex")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Each file's name and its bytes as UTF-8 text. */
export async function unzippedText(blob: Blob | Buffer): Promise<Array<[string, string]>> {
  return (await unzipped(blob)).map(([name, bytes]) => [name, bytes.toString("utf8")]);
}
