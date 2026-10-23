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

/** The summary of a report with one test of `status`, in a CI job's environment. */
function summary(status: "unexpected" | "flaky", env: Record<string, string>) {
  const results = status === "flaky" ? [{ status: "failed", duration: 1, error: { message: "Error: fel" } }, { status: "passed", duration: 1 }] : [{ status: "failed", duration: 1, error: { message: "Error: fel" } }];
  const report = { suites: [{ specs: [{ file: "a11y.spec.ts", line: 1, title: "list", tests: [{ projectName: "tablet-portrait", status, annotations: [], results }] }] }] };
  const file = join(mkdtempSync(join(tmpdir(), "ci-summary-")), "results.json");
  writeFileSync(file, JSON.stringify(report));
  const { GATE_FAIL_ON_FLAKY: _, ...inherited } = process.env;
  const result = spawnSync(process.execPath, [SCRIPT, file, "gate-results-scan-3"], { encoding: "utf8", env: { ...inherited, GITHUB_RUN_ID: "18800000001", GITHUB_REPOSITORY: "eneo-ai/eneo-mod-speech-to-text", ...env } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("a failed job's summary gives the command that downloads the artifact it names, a gate job's too", () => {
  assert.match(summary("unexpected", {}), /`gh run download 18800000001 -R eneo-ai\/eneo-mod-speech-to-text -n gate-results-scan-3 -D gate-results-scan-3`/);
});

test("a flaky test names the artifact only where flakiness fails the job, the only case its results are kept", () => {
  assert.doesNotMatch(summary("flaky", {}), /gh run download/);
  assert.match(summary("flaky", { GATE_FAIL_ON_FLAKY: "1" }), /gh run download 18800000001/);
});
