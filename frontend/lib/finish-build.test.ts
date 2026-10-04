import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// The first-paint script as Vite leaves it: a file beside the page that the page names. The build gives it a name of its
// content under assets/, so the backend can serve it as immutable like the rest of assets/.
const SCRIPT_TAG = '<script src="/color-mode.js"></script>';
const COLOR_MODE = readFileSync(join(__dirname, "..", "..", "public", "color-mode.js"));
const hashName = (content: Buffer | string) => `color-mode.${createHash("sha256").update(content).digest("hex").slice(0, 8)}.js`;
const hashedTag = (content: Buffer | string = COLOR_MODE) => `<script src="/assets/${hashName(content)}"></script>`;

/** A built directory as Vite leaves it: the page, hashed assets, and a file beside the page. */
function built(page = `<!doctype html><title>x</title>${VITE_MARKER}${SCRIPT_TAG}`, name = "finish-build-"): string {
  const dir = mkdtempSync(join(tmpdir(), name));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), page);
  writeFileSync(join(dir, "color-mode.js"), COLOR_MODE);
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
    writeFileSync(join(dir, "index.html"), `<!doctype html><head>${VITE_MARKER}<title>x</title>${SCRIPT_TAG}</head>`);
    writeFileSync(join(dir, "color-mode.js"), COLOR_MODE);
    const result = run(dir);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    const page = readFileSync(join(dir, "index.html"), "utf8");
    assert.equal(page.split(BACKEND_MARKER).length - 1, 1, `${name}: the exact marker, once`);
    assert.ok(!page.includes(VITE_MARKER), `${name}: not the form Vite writes`);
    assert.equal(page, `<!doctype html><head>${BACKEND_MARKER}<title>x</title>${hashedTag()}</head>`, `${name}: nothing else of the page changed but the script's name`);
  }
});

test("a page that already has the exact marker is left as it is, and a second run changes nothing", () => {
  const dir = built(`<!doctype html>${BACKEND_MARKER}${SCRIPT_TAG}`);
  assert.equal(run(dir).status, 0);
  assert.equal(readFileSync(join(dir, "index.html"), "utf8"), `<!doctype html>${BACKEND_MARKER}${hashedTag()}`);
  assert.equal(run(dir).status, 0);
  assert.equal(readFileSync(join(dir, "index.html"), "utf8"), `<!doctype html>${BACKEND_MARKER}${hashedTag()}`);
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

test("the first-paint script is renamed by its content under assets/, the page names it, and no copy is left at the root", () => {
  const dir = built();
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  const name = hashName(COLOR_MODE);
  assert.match(name, /^color-mode\.[0-9a-f]{8}\.js$/);
  assert.deepEqual(readFileSync(join(dir, "assets", name)), COLOR_MODE, "the file, as it was");
  assert.equal(existsSync(join(dir, "color-mode.js")), false, "no root copy");
  const page = readFileSync(join(dir, "index.html"), "utf8");
  assert.ok(page.includes(`<script src="/assets/${name}"></script>`), "the page names the new file");
  assert.ok(!page.includes('"/color-mode.js"'), "and no longer the old one");
  assert.deepEqual(brotliDecompressSync(readFileSync(join(dir, "assets", `${name}.br`))), COLOR_MODE, "it is compressed like the rest of assets/");
  assert.deepEqual(gunzipSync(readFileSync(join(dir, "assets", `${name}.gz`))), COLOR_MODE);
});

test("the script's name follows its content: the same content, the same name, another content, another", () => {
  const names = (content: string) => {
    const dir = built();
    writeFileSync(join(dir, "color-mode.js"), content);
    assert.equal(run(dir).status, 0);
    return readFileSync(join(dir, "index.html"), "utf8").match(/assets\/(color-mode\.[0-9a-f]{8}\.js)/)![1];
  };
  assert.equal(names("a();"), names("a();"));
  assert.notEqual(names("a();"), names("b();"));
  assert.equal(names("a();"), hashName("a();"));
});

test("a second run leaves the script, the page and the siblings as they are", () => {
  const dir = built();
  run(dir);
  const [page, script] = [readFileSync(join(dir, "index.html"), "utf8"), readFileSync(join(dir, "assets", hashName(COLOR_MODE)))];
  assert.equal(run(dir).status, 0);
  assert.equal(readFileSync(join(dir, "index.html"), "utf8"), page);
  assert.deepEqual(readFileSync(join(dir, "assets", hashName(COLOR_MODE))), script);
  assert.equal(existsSync(join(dir, "color-mode.js")), false);
});

test("a build without its first-paint script fails: the file or the page's tag missing, the tag twice, or a hashed name that is not the file's", () => {
  const cases: [string, (dir: string) => void][] = [
    ["the page names it and the file is not there", (dir) => rmSync(join(dir, "color-mode.js"))],
    ["the file is there and the page does not name it", (dir) => writeFileSync(join(dir, "index.html"), `<!doctype html>${VITE_MARKER}`)],
    ["the page names it twice", (dir) => writeFileSync(join(dir, "index.html"), `<!doctype html>${VITE_MARKER}${SCRIPT_TAG}${SCRIPT_TAG}`)],
    ["neither the file nor the tag", (dir) => (rmSync(join(dir, "color-mode.js")), writeFileSync(join(dir, "index.html"), `<!doctype html>${VITE_MARKER}`))],
    [
      "the page names a hashed script that is not the one in assets/",
      (dir) => (
        rmSync(join(dir, "color-mode.js")),
        writeFileSync(join(dir, "assets", "color-mode.00000000.js"), "x();"),
        writeFileSync(join(dir, "index.html"), `<!doctype html>${VITE_MARKER}<script src="/assets/color-mode.00000000.js"></script>`)
      ),
    ],
  ];
  for (const [what, damage] of cases) {
    const dir = built();
    damage(dir);
    const result = run(dir);
    assert.notEqual(result.status, 0, what);
    assert.match(result.stderr, /color-mode/, `${what}: says which script`);
    assert.equal(existsSync(join(dir, "assets", "app-Abc12345.js.br")), false, `${what}: nothing is compressed for a build that fails`);
  }
});

test("dist and dist-check each end with their own hashed script and no root copy", () => {
  for (const name of ["dist", "dist-check"]) {
    const dir = join(mkdtempSync(join(tmpdir(), "finish-build-out-")), name);
    mkdirSync(dir);
    writeFileSync(join(dir, "index.html"), `<!doctype html><head>${VITE_MARKER}${SCRIPT_TAG}</head>`);
    writeFileSync(join(dir, "color-mode.js"), COLOR_MODE);
    assert.equal(run(dir).status, 0, name);
    assert.equal(existsSync(join(dir, "color-mode.js")), false, `${name}: no root copy`);
    assert.ok(existsSync(join(dir, "assets", hashName(COLOR_MODE))), `${name}: the hashed script`);
    assert.ok(readFileSync(join(dir, "index.html"), "utf8").includes(`/assets/${hashName(COLOR_MODE)}`), `${name}: the page names it`);
  }
});
