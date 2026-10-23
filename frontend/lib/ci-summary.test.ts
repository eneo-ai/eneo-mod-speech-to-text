import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = join(__dirname, "..", "..", "scripts", "ci-summary.mjs");

test("a test that failed and then passed on its retry is listed as flaky with the failed attempt's error", () => {
  const report = {
    suites: [
      {
        specs: [
          {
            file: "aria.spec.ts",
            line: 58,
            title: "aria run-progress",
            tests: [
              {
                projectName: "laptop-1440-webkit",
                status: "flaky",
                annotations: [],
                results: [
                  { status: "failed", duration: 1000, error: { message: "Error: the snapshot differs\nmore detail" } },
                  { status: "passed", duration: 500 },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const file = join(mkdtempSync(join(tmpdir(), "ci-summary-")), "results.json");
  writeFileSync(file, JSON.stringify(report));
  const result = spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| laptop-1440-webkit \| 0 \| 0 \| 1 \| 0 \|/, "counted once, as flaky");
  assert.match(result.stdout, /\| laptop-1440-webkit \| aria\.spec\.ts:58 aria run-progress \| Error: the snapshot differs · more detail \|/);
  assert.match(result.stdout, /\| 2 \| laptop-1440-webkit \| aria\.spec\.ts:58 aria run-progress \|/, "both attempts' time");
});
