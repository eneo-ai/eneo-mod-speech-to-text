// Finishes a Vite build in the directory it is given, and nowhere else: `node scripts/finish-build.mjs dist` (or
// `dist-check`). The backend serves the result as it is, so what a browser can be sent compressed is compressed here.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const dir = process.argv[2] === undefined || process.argv.length > 3 ? null : resolve(process.argv[2]);
if (dir === null) fail("Usage: node scripts/finish-build.mjs <build directory>");
if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`${dir} is not a directory.`);
if (!existsSync(join(dir, "index.html"))) fail(`${dir} has no index.html: it is not a build.`);

/** Text the browser can be sent compressed. Fonts and images are compressed already. */
const COMPRESSIBLE = new Set([".js", ".css", ".svg", ".json"]);

const assets = join(dir, "assets");
if (existsSync(assets)) {
  for (const name of readdirSync(assets)) {
    if (!COMPRESSIBLE.has(extname(name))) continue;
    const file = join(assets, name);
    const content = readFileSync(file);
    writeFileSync(`${file}.br`, brotliCompressSync(content, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
    writeFileSync(`${file}.gz`, gzipSync(content, { level: 9 }));
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
