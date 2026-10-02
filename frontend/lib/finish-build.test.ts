import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

const SCRIPT = join(__dirname, "..", "..", "scripts", "finish-build.mjs");

const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

/** A built directory as Vite leaves it: the page, hashed assets, and a file beside the page. */
function built(): string {
  const dir = mkdtempSync(join(tmpdir(), "finish-build-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>x</title>");
  writeFileSync(join(dir, "assets", "app-abc.js"), "export const a = 1;\n".repeat(200));
  writeFileSync(join(dir, "assets", "app-abc.css"), "a { color: red }\n".repeat(200));
  writeFileSync(join(dir, "assets", "mark-abc.svg"), "<svg></svg>".repeat(100));
  writeFileSync(join(dir, "assets", "font-abc.woff2"), "not compressible again");
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
  for (const name of ["app-abc.js", "app-abc.css", "mark-abc.svg"]) {
    const original = readFileSync(join(dir, "assets", name));
    assert.deepEqual(brotliDecompressSync(readFileSync(join(dir, "assets", `${name}.br`))), original, `${name}.br`);
    assert.deepEqual(gunzipSync(readFileSync(join(dir, "assets", `${name}.gz`))), original, `${name}.gz`);
    assert.ok(readFileSync(join(dir, "assets", `${name}.br`)).length < original.length, `${name}.br is smaller`);
  }
});

test("what is compressed already, the page and the files beside it are left as they are", () => {
  const dir = built();
  run(dir);
  assert.equal(existsSync(join(dir, "assets", "font-abc.woff2.br")), false);
  assert.equal(existsSync(join(dir, "assets", "font-abc.woff2.gz")), false);
  assert.equal(existsSync(join(dir, "index.html.br")), false);
  assert.equal(existsSync(join(dir, "live-pcm-worklet.js.br")), false);
});

test("a second run compresses the same files again and nothing more", () => {
  const dir = built();
  run(dir);
  const before = readFileSync(join(dir, "assets", "app-abc.js.br"));
  assert.equal(run(dir).status, 0);
  assert.deepEqual(readFileSync(join(dir, "assets", "app-abc.js.br")), before);
  assert.equal(existsSync(join(dir, "assets", "app-abc.js.br.br")), false, "a sibling is not compressed in turn");
  assert.equal(existsSync(join(dir, "assets", "app-abc.js.gz.br")), false);
});
