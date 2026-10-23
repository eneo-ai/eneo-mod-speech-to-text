import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const FRONTEND = join(__dirname, "..", "..");
const SCRIPT = join(FRONTEND, "scripts", "controls-shard.mjs");
const PROJECTS = ["--project=phone-390-light", "--project=laptop-1440-light"];
// CI's browser jobs send Playwright's JSON report to a file (PLAYWRIGHT_JSON_OUTPUT_NAME in ci.yml and gate.yml).
const CI = { ...process.env, CI: "true", PLAYWRIGHT_JSON_OUTPUT_NAME: join(mkdtempSync(join(tmpdir(), "controls-shard-")), "results.json") };
const { PLAYWRIGHT_JSON_OUTPUT_NAME: _, ...LOCAL } = process.env;

type Suite = { specs?: { title: string; tests: { projectName: string }[] }[]; suites?: Suite[] };

/** The controls tests Playwright runs for the projects, and a --grep, as "<project> <title>". */
function listed(grep?: string) {
  const args = ["playwright", "test", "controls.spec.ts", "--list", "--reporter=json", ...PROJECTS, ...(grep ? [`--grep=${grep}`] : [])];
  const report = JSON.parse(execFileSync("npx", args, { cwd: FRONTEND, env: LOCAL, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
  const found: string[] = [];
  const walk = (suite: Suite) => {
    for (const spec of suite.specs ?? []) for (const one of spec.tests) found.push(`${one.projectName} ${spec.title}`);
    (suite.suites ?? []).forEach(walk);
  };
  report.suites.forEach(walk);
  return found;
}

const shard = (which: string, env: NodeJS.ProcessEnv = CI) => spawnSync(process.execPath, [SCRIPT, which, ...PROJECTS], { cwd: FRONTEND, env, encoding: "utf8" });

test("in CI's environment, every controls test lands in exactly one of the five shards", () => {
  const all = listed();
  assert.ok(all.length > 5, "controls.spec.ts has tests for the projects");
  const run: string[] = [];
  for (let n = 1; n <= 5; n += 1) {
    const result = shard(`${n}/5`);
    assert.equal(result.status, 0, result.stderr);
    run.push(...listed(result.stdout.trim()));
  }
  assert.deepEqual(run.sort(), all.sort());
});

test("a shard with no test in it fails instead of printing an empty filter, which would run every test", () => {
  const result = shard("500/500", LOCAL);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
});
