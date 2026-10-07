import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = join(__dirname, "..", "..", "scripts", "verify-candidate.mjs");
const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

test("the candidate CLI isolates working code, new tests and dependencies, excludes ignored files, and detects later changes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "stt-candidate-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const write = (name: string, content: string) => {
    const file = join(source, name);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content);
  };
  write(".gitignore", "node_modules/\n.env\n");
  write("frontend/lib/app.ts", "export const label = 'old';");
  write("frontend/package-lock.json", "{}");
  write("backend/app/main.py", "VERSION = 1");
  write(".github/workflows/ci.yml", "jobs: {}");
  spawnSync("git", ["init", "-q", source]);
  assert.equal(spawnSync("git", ["-C", source, "add", "."]).status, 0);
  write("frontend/lib/app.ts", "export const label = 'current';");
  write("frontend/tests/e2e/new.spec.ts", "new test");
  write("frontend/node_modules/fixture/index.js", "dependency");
  symlinkSync(join(source, "frontend/node_modules"), join(source, "backend/.venv"), "dir");
  write(".env", "private");
  const preparing = run("--source", source, "--prepare-only", "--checks", "dev,real", "--grep", "one focus frame");
  assert.equal(preparing.status, 0, preparing.stderr);
  const { candidate } = JSON.parse(preparing.stdout) as { candidate: string };
  // The fixture owns these temporary directories, including their read-only files.
  t.after(() => rmSync(candidate, { recursive: true, force: true }));
  assert.deepEqual(JSON.parse(readFileSync(join(candidate, "candidate.json"), "utf8")).selection.checks, ["dev", "real"]);
  assert.equal(readFileSync(join(candidate, "frontend/lib/app.ts"), "utf8"), "export const label = 'current';");
  assert.equal(readFileSync(join(candidate, "frontend/tests/e2e/new.spec.ts"), "utf8"), "new test");
  assert.equal(existsSync(join(candidate, ".env")), false);
  assert.equal(existsSync(join(candidate, "backend/.venv")), false);
  assert.equal(readFileSync(join(candidate, ".github/workflows/ci.yml"), "utf8"), "jobs: {}", "backend checks also read repository CI contracts");
  assert.equal(statSync(join(candidate, "frontend/lib/app.ts")).mode & 0o222, 0);
  write("frontend/lib/app.ts", "changed while testing");
  write("frontend/node_modules/fixture/index.js", "changed dependency");
  assert.equal(readFileSync(join(candidate, "frontend/node_modules/fixture/index.js"), "utf8"), "dependency");
  assert.equal(run("--verify", candidate).status, 0, "edits to the workspace do not invalidate the candidate");
  const captured = join(candidate, "frontend/tests/e2e/new.spec.ts");
  chmodSync(captured, 0o644);
  writeFileSync(captured, "changed candidate");
  const changed = run("--verify", candidate);
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /frontend\/tests\/e2e\/new\.spec\.ts/);
  writeFileSync(captured, "new test");
  chmodSync(captured, 0o444);
  const added = join(candidate, "frontend/tests/e2e/added.spec.ts");
  writeFileSync(added, "added during the run");
  const extra = run("--verify", candidate);
  assert.notEqual(extra.status, 0);
  assert.match(extra.stderr, /frontend\/tests\/e2e\/added\.spec\.ts/);
  rmSync(join(source, "frontend/node_modules"), { recursive: true, force: true });
  const failedCapture = run("--source", source, "--prepare-only");
  assert.notEqual(failedCapture.status, 0);
  const failed = /candidate: (.+)/.exec(failedCapture.stderr)?.[1];
  assert.ok(failed, "a failed capture leaves its location and reason");
  t.after(() => rmSync(failed, { recursive: true, force: true }));
  assert.equal(JSON.parse(readFileSync(join(failed, "candidate.json"), "utf8")).status, "capture_failed");
});

test("candidate status distinguishes genuine skips, interruptions and tests that never ran", (t) => {
  const candidate = mkdtempSync(join(tmpdir(), "stt-candidate-status-"));
  t.after(() => rmSync(candidate, { recursive: true, force: true }));
  mkdirSync(join(candidate, "frontend/test-results"), { recursive: true });
  writeFileSync(join(candidate, "candidate.json"), JSON.stringify({
    source: "fixture", status: "interrupted", steps: [{ name: "real", status: "failed", finishedAt: "2026-10-07" }],
  }));
  writeFileSync(join(candidate, "frontend/test-results/real.json"), JSON.stringify({
    stats: { expected: 1, unexpected: 1, flaky: 1, skipped: 3 },
    suites: [{ suites: [{ specs: [{ tests: [
      { status: "expected", results: [{ status: "passed" }] },
      { status: "unexpected", results: [{ status: "failed" }] },
      { status: "flaky", results: [{ status: "failed" }, { status: "passed" }] },
      { status: "skipped", results: [{ status: "skipped" }] },
      { status: "skipped", results: [{ status: "interrupted" }] },
      { status: "skipped", results: [] },
    ] }] }] }],
  }));
  const result = run("--status", candidate);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).steps[0].tests, {
    passed: 1, failed: 1, flaky: 1, skipped: 1, interrupted: 1, notRun: 1,
  });
});

test("a backend runtime changed during a check invalidates the candidate", (t) => {
  const root = mkdtempSync(join(tmpdir(), "stt-candidate-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(join(source, "frontend/node_modules"), { recursive: true });
  mkdirSync(join(source, "backend/tests"), { recursive: true });
  writeFileSync(join(source, "backend/tests/test_runtime.py"), "# fixture\n");
  writeFileSync(join(source, ".gitignore"), "node_modules/\n");
  writeFileSync(join(source, "frontend/package.json"), "{}");
  spawnSync("git", ["init", "-q", source]);
  assert.equal(spawnSync("git", ["-C", source, "add", "."]).status, 0);
  const version = join(root, "runtime-version");
  writeFileSync(version, "before");
  const python = join(root, "python");
  writeFileSync(python, `#!${process.execPath}\nconst fs = require('node:fs');
if (process.argv[2] === '-c') console.log(JSON.stringify({executable: process.argv[1], version: fs.readFileSync(${JSON.stringify(version)}, 'utf8'), packagesHash: 'fixture'}));
else fs.writeFileSync(${JSON.stringify(version)}, 'after');\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [SCRIPT, "--source", source, "--checks", "backend"], {
    encoding: "utf8", env: { ...process.env, BACKEND_PYTHON: python },
  });
  const candidate = /Candidate: (.+)/.exec(result.stdout)?.[1];
  assert.ok(candidate, result.stderr);
  t.after(() => rmSync(candidate, { recursive: true, force: true }));
  assert.notEqual(result.status, 0, "the backend returning zero does not hide runtime drift");
  assert.match(result.stderr, /External runtime changed/);
  const manifest = JSON.parse(readFileSync(join(candidate, "candidate.json"), "utf8"));
  assert.equal(manifest.status, "failed");
  assert.equal(manifest.steps[0].status, "failed");
  assert.equal(manifest.runtime.python[0].version, "before");
});

test("runtime identity allows missing optional browser installs and detects a later installation", (t) => {
  const root = mkdtempSync(join(tmpdir(), "stt-candidate-browsers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const browsers = join(root, "browsers");
  mkdirSync(join(source, "frontend/node_modules"), { recursive: true });
  mkdirSync(browsers);
  writeFileSync(join(source, ".gitignore"), "node_modules/\n");
  writeFileSync(join(source, "frontend/package.json"), "{}");
  cpSync(join(require.resolve("playwright-core/package.json"), ".."), join(source, "frontend/node_modules/playwright-core"), { recursive: true });
  spawnSync("git", ["init", "-q", source]);
  assert.equal(spawnSync("git", ["-C", source, "add", "."]).status, 0);
  const result = spawnSync(process.execPath, [SCRIPT, "--source", source, "--checks", "review"], {
    encoding: "utf8", env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
  });
  const candidate = /Candidate: (.+)/.exec(result.stdout)?.[1];
  assert.ok(candidate, result.stderr);
  t.after(() => rmSync(candidate, { recursive: true, force: true }));
  // This fixture has no build script. Runtime capture must finish before that deliberate failure.
  assert.notEqual(result.status, 0);
  const manifest = JSON.parse(readFileSync(join(candidate, "candidate.json"), "utf8"));
  assert.ok(manifest.runtime, result.stderr);
  assert.ok(manifest.runtime.browsers.installs.every((browser: { filesHash: string | null }) => browser.filesHash === null));
  const verifying = () => spawnSync(process.execPath, [SCRIPT, "--verify", candidate], {
    encoding: "utf8", env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
  });
  assert.equal(verifying().status, 0);
  mkdirSync(manifest.runtime.browsers.installs.find((browser: { name: string }) => browser.name === "firefox").directory);
  const changed = verifying();
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /External runtime changed/);
});
