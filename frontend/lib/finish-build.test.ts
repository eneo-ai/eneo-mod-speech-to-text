import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

const SCRIPT = join(__dirname, "..", "..", "scripts", "finish-build.mjs");

const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

// The marker as Vite serialises the tag of index.html (a space and a slash), and as the backend looks for it: it
// replaces this exact string with the organisation (backend/app/web.py BRANDING_MARKER) and refuses to start on a page
// that does not hold it once.
const VITE_MARKER = '<meta name="eneo-branding" content="" />';
const BACKEND_MARKER = readFileSync(join(__dirname, "..", "..", "..", "backend", "app", "web.py"), "utf8").match(/^BRANDING_MARKER = '(.*)'$/m)![1];

/** A built directory as Vite leaves it: the page, hashed assets, and a file beside the page. */
function built(page = `<!doctype html><title>x</title>${VITE_MARKER}`, name = "finish-build-"): string {
  const dir = mkdtempSync(join(tmpdir(), name));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), page);
  writeFileSync(join(dir, "assets", "app-Abc12345.js"), "export const a = 1;\n".repeat(200));
  writeFileSync(join(dir, "assets", "app-Abc12345.css"), "a { color: red }\n".repeat(200));
  writeFileSync(join(dir, "assets", "mark-Abc12345.svg"), "<svg></svg>".repeat(100));
  writeFileSync(join(dir, "assets", "font-Abc12345.woff2"), "not compressible again");
  writeFileSync(join(dir, "live-pcm-worklet.js"), "registerProcessor();\n".repeat(50));
  return dir;
}

test("it takes one directory, and refuses none, a missing one, or one that is not a build", () => {
  assert.notEqual(run().status, 0, "no argument");
  assert.match(run().stderr, /Usage/);
  assert.notEqual(run(join(tmpdir(), "finish-build-missing")).status, 0, "missing directory");
  const empty = mkdtempSync(join(tmpdir(), "finish-build-"));
  const refused = run(empty);
  assert.notEqual(refused.status, 0, "no index.html");
  assert.match(refused.stderr, /index\.html/);
  assert.notEqual(run(built(), "extra").status, 0, "a second argument");
});

test("every script, stylesheet and svg under assets/ gets a brotli and a gzip sibling that decompress to it", () => {
  const dir = built();
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  for (const name of ["app-Abc12345.js", "app-Abc12345.css", "mark-Abc12345.svg"]) {
    const original = readFileSync(join(dir, "assets", name));
    assert.deepEqual(brotliDecompressSync(readFileSync(join(dir, "assets", `${name}.br`))), original, `${name}.br`);
    assert.deepEqual(gunzipSync(readFileSync(join(dir, "assets", `${name}.gz`))), original, `${name}.gz`);
    assert.ok(readFileSync(join(dir, "assets", `${name}.br`)).length < original.length, `${name}.br is smaller`);
  }
});

test("what is compressed already, the page and the files beside it are left as they are", () => {
  const dir = built();
  run(dir);
  assert.equal(existsSync(join(dir, "assets", "font-Abc12345.woff2.br")), false);
  assert.equal(existsSync(join(dir, "assets", "font-Abc12345.woff2.gz")), false);
  assert.equal(existsSync(join(dir, "index.html.br")), false);
  assert.equal(existsSync(join(dir, "live-pcm-worklet.js.br")), false);
});

test("a second run compresses the same files again and nothing more", () => {
  const dir = built();
  run(dir);
  const before = readFileSync(join(dir, "assets", "app-Abc12345.js.br"));
  assert.equal(run(dir).status, 0);
  assert.deepEqual(readFileSync(join(dir, "assets", "app-Abc12345.js.br")), before);
  assert.equal(existsSync(join(dir, "assets", "app-Abc12345.js.br.br")), false, "a sibling is not compressed in turn");
  assert.equal(existsSync(join(dir, "assets", "app-Abc12345.js.gz.br")), false);
});

test("the backend's marker is the exact string the build leaves, which is not the one Vite writes", () => {
  assert.equal(BACKEND_MARKER, '<meta name="eneo-branding" content="">', "the contract the backend reads");
  assert.notEqual(VITE_MARKER, BACKEND_MARKER);
});

test("the build leaves the marker in the backend's exact form, once, in dist and in dist-check", () => {
  for (const name of ["dist", "dist-check"]) {
    const dir = join(mkdtempSync(join(tmpdir(), "finish-build-out-")), name);
    mkdirSync(dir);
    writeFileSync(join(dir, "index.html"), `<!doctype html><head>${VITE_MARKER}<title>x</title></head>`);
    const result = run(dir);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    const page = readFileSync(join(dir, "index.html"), "utf8");
    assert.equal(page.split(BACKEND_MARKER).length - 1, 1, `${name}: the exact marker, once`);
    assert.ok(!page.includes(VITE_MARKER), `${name}: not the form Vite writes`);
    assert.equal(page, `<!doctype html><head>${BACKEND_MARKER}<title>x</title></head>`, `${name}: nothing else of the page changed`);
  }
});

test("a page that already has the exact marker is left as it is, and a second run changes nothing", () => {
  const dir = built(`<!doctype html>${BACKEND_MARKER}`);
  assert.equal(run(dir).status, 0);
  assert.equal(readFileSync(join(dir, "index.html"), "utf8"), `<!doctype html>${BACKEND_MARKER}`);
  assert.equal(run(dir).status, 0);
  assert.equal(readFileSync(join(dir, "index.html"), "utf8"), `<!doctype html>${BACKEND_MARKER}`);
});

test("the build fails unless exactly one marker is left: none, two, or one that holds something", () => {
  for (const [what, page] of [
    ["no marker", "<!doctype html><title>x</title>"],
    ["two markers", `<!doctype html>${VITE_MARKER}${BACKEND_MARKER}`],
    ["a marker that holds an organisation already", '<!doctype html><meta name="eneo-branding" content="{}">'],
    ["a second tag of the name", `<!doctype html>${VITE_MARKER}<meta name="eneo-branding" content="x">`],
  ] as const) {
    const dir = built(page);
    const result = run(dir);
    assert.notEqual(result.status, 0, what);
    assert.match(result.stderr, /eneo-branding/, `${what}: says which tag`);
    assert.equal(existsSync(join(dir, "assets", "app-Abc12345.js.br")), false, `${what}: nothing is compressed for a build that fails`);
  }
});

test("a bundle that asks for /api/branding fails the build: the page reads the organisation from its marker", () => {
  for (const [what, code] of [
    ["fetch with double quotes", 'fetch("/api/branding",{cache:"no-store"})'],
    ["fetch with single quotes", "fetch('/api/branding')"],
    ["a template literal", "fetch(`/api/branding`)"],
  ] as const) {
    const dir = built();
    writeFileSync(join(dir, "assets", "branding-Abc12345.js"), `export const read=()=>${code};\n`);
    const result = run(dir);
    assert.notEqual(result.status, 0, what);
    assert.match(result.stderr, /api\/branding/, `${what}: says what it found`);
    assert.ok(result.stderr.includes("branding-Abc12345.js"), `${what}: names the file`);
    assert.equal(existsSync(join(dir, "assets", "app-Abc12345.js.br")), false, `${what}: nothing is compressed for a build that fails`);
  }
});

test("the logo files and the stylesheet the page points at are not a branding fetch", () => {
  const dir = built();
  writeFileSync(join(dir, "assets", "brand-Abc12345.js"), 'export const a="/api/branding/logo/light",b="/api/branding/logo/dark",c="/api/branding/theme.css";\n');
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
});

test("a file under assets/ without a content hash in its name fails the build: the backend serves assets/ as immutable for a year", () => {
  for (const [what, name] of [
    ["a script with no hash", "app.js"],
    ["a short word where the hash goes", "app-abc.js"],
    ["a stylesheet with no hash", "styles.css"],
    ["a font with no hash", "inter.woff2"],
  ] as const) {
    const dir = built();
    writeFileSync(join(dir, "assets", name), "x");
    const result = run(dir);
    assert.notEqual(result.status, 0, what);
    assert.ok(result.stderr.includes(name), `${what}: names the file`);
    assert.equal(existsSync(join(dir, "assets", "app-Abc12345.js.br")), false, `${what}: nothing is compressed for a build that fails`);
  }
  const nested = built();
  mkdirSync(join(nested, "assets", "sub"));
  writeFileSync(join(nested, "assets", "sub", "plain.js"), "x");
  const result = run(nested);
  assert.notEqual(result.status, 0, "a file in a folder of assets/ as well");
  assert.ok(result.stderr.includes("plain.js"));
});

test("the names a build gives are accepted: Vite's name-hash, a name with a dot in it, and a hash that holds - and _", () => {
  const dir = built();
  for (const name of ["index-DcwA4C2_.js", "focusOutline.stylex-hI6fYgmv.js", "Dialog-D-cwA4_2.css", "color-mode.1a2b3c4d.js"]) writeFileSync(join(dir, "assets", name), "export {};\n".repeat(20));
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(run(dir).status, 0, "and again, with the compressed siblings there");
});
