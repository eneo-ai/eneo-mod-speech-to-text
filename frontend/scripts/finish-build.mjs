// Finishes a Vite build in the directory it is given, and nowhere else: `node scripts/finish-build.mjs dist` (or
// `dist-check`). The backend serves the result as it is, so what a browser can be sent compressed is compressed here.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const dir = process.argv[2] === undefined || process.argv.length > 3 ? null : resolve(process.argv[2]);
if (dir === null) fail("Usage: node scripts/finish-build.mjs <build directory>");
if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`${dir} is not a directory.`);
if (!existsSync(join(dir, "index.html"))) fail(`${dir} has no index.html: it is not a build.`);

// The backend writes the organisation into the page at start by replacing this exact string (backend/app/web.py,
// BRANDING_MARKER), and refuses to start on a page that does not hold it once. Vite serialises the tag as
// `<meta name="eneo-branding" content="" />`, a space and a slash that the backend would not find: the page leaves here
// with the one form it reads.
const MARKER = '<meta name="eneo-branding" content="">';
let page = readFileSync(join(dir, "index.html"), "utf8").replace(/<meta name="eneo-branding" content=""\s*\/?>/g, MARKER);
if (page.split(MARKER).length !== 2 || page.split('name="eneo-branding"').length !== 2) {
  fail(`${join(dir, "index.html")} must hold exactly one ${MARKER}, and no other tag named eneo-branding.`);
}

const assets = join(dir, "assets");

// The first-paint script (public/color-mode.js) stands beside the page, which names it. The backend serves everything
// under assets/ as immutable for a year, so the script goes there under a name of its content, and the page names that.
// A directory this script finished before has its page naming the hashed script already, which is there and is its content's.
const SCRIPT_TAG = '<script src="/color-mode.js"></script>';
const contentHash = (content) => createHash("sha256").update(content).digest("hex").slice(0, 8);
const rootScript = join(dir, "color-mode.js");
let script = null;
if (existsSync(rootScript)) {
  if (page.split(SCRIPT_TAG).length !== 2) {
    fail(`${join(dir, "index.html")} must name /color-mode.js exactly once, as ${SCRIPT_TAG}.`);
  }
  const content = readFileSync(rootScript);
  script = { name: `color-mode.${contentHash(content)}.js`, content };
  page = page.replace(SCRIPT_TAG, `<script src="/assets/${script.name}"></script>`);
} else {
  const named = [...page.matchAll(/<script src="\/assets\/(color-mode\.([0-9a-f]{8})\.js)"><\/script>/g)];
  const file = named.length === 1 ? join(assets, named[0][1]) : null;
  if (file === null || !existsSync(file) || contentHash(readFileSync(file)) !== named[0][2]) {
    fail(`${join(dir, "index.html")} needs the first-paint script: ${rootScript} with ${SCRIPT_TAG} in the page, or the page naming assets/color-mode.<hash>.js, which is the file's content.`);
  }
}
if (page.includes('"/color-mode.js"')) fail(`${join(dir, "index.html")} still names /color-mode.js.`);

if (script !== null) {
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, script.name), script.content);
  rmSync(rootScript);
}
writeFileSync(join(dir, "index.html"), page);

/** Text the browser can be sent compressed. Fonts and images are compressed already. */
const COMPRESSIBLE = new Set([".js", ".css", ".svg", ".json"]);

const files = existsSync(assets)
  ? readdirSync(assets, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
  : [];

// The backend serves everything under assets/ as immutable for a year, so every file there must be named by its content
// (Vite's name-hash, or name.hash): a file that is replaced under the same name would be cached for good. The siblings
// compressed here belong to a file that was checked.
const HASHED = /[-.][A-Za-z0-9_-]{8}$/;
const unhashed = files.filter((file) => !/\.(br|gz)$/.test(file) && !HASHED.test(basename(file, extname(file))));
if (unhashed.length > 0) {
  fail(`Files under ${assets} without a content hash in their name, which the backend would cache for a year:\n${unhashed.map((file) => `  ${relative(assets, file)}`).join("\n")}`);
}

for (const file of files) {
  if (!COMPRESSIBLE.has(extname(file))) continue;
  const content = readFileSync(file);
  writeFileSync(`${file}.br`, brotliCompressSync(content, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
  writeFileSync(`${file}.gz`, gzipSync(content, { level: 9 }));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
