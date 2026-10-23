// A CI job's Playwright results as Markdown for the job's summary page ($GITHUB_STEP_SUMMARY): counts per project, every
// test that failed or passed only on its retry (flaky) with the first lines of its error, the skips by reason, and the
// slowest tests. A pull request then shows what went wrong without opening 5000 lines of log.
//
//   node scripts/ci-summary.mjs test-results/results.json "<artifact with the pictures and traces>" >> "$GITHUB_STEP_SUMMARY"

import { existsSync, readFileSync } from "node:fs";

const [file = "test-results/results.json", artifact] = process.argv.slice(2);
if (!existsSync(file)) {
  console.log(`No Playwright results at \`${file}\`: the tests did not run (see the job's log).`);
  process.exit(0);
}
const report = JSON.parse(readFileSync(file, "utf8"));
const plain = (text) => String(text ?? "").replace(/\u001b\[[0-9;]*m/g, "");
// The lines of an error that say what failed: not the matcher's diff header around a list of problems.
const brief = (message) =>
  plain(message)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^(expect\(|- Expected|\+ Received|- Array \[\]|\+ Array \[|\+ \]$)/.test(line))
    .slice(0, 4)
    .join("\n");
const cell = (text) => plain(text).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " · ").slice(0, 400);

const tests = [];
const walk = (suite) => {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests) {
      // The last attempt that failed: a flaky test's last attempt passed and holds no error.
      const failed = test.results.findLast((result) => result.error || result.errors?.length);
      tests.push({
        title: `${spec.file}:${spec.line} ${spec.title}`,
        project: test.projectName,
        status: test.status, // expected | unexpected | flaky | skipped
        seconds: test.results.reduce((sum, result) => sum + result.duration, 0) / 1000,
        error: failed?.error?.message ?? failed?.errors?.[0]?.message ?? "",
        skip: test.annotations.find((a) => a.type === "skip")?.description ?? "no reason given",
      });
    }
  }
  (suite.suites ?? []).forEach(walk);
};
report.suites.forEach(walk);

const lines = [];
const projects = [...new Set(tests.map((t) => t.project))].sort();
lines.push("| Project | Passed | Failed | Flaky | Skipped |", "|---|---|---|---|---|");
for (const project of projects) {
  const own = tests.filter((t) => t.project === project);
  const count = (status) => own.filter((t) => t.status === status).length;
  lines.push(`| ${project} | ${count("expected")} | ${count("unexpected")} | ${count("flaky")} | ${count("skipped")} |`);
}

const listed = (status, heading) => {
  const own = tests.filter((t) => t.status === status);
  if (!own.length) return;
  lines.push("", `### ${heading} (${own.length})`, "", "| Project | Test | Error |", "|---|---|---|");
  for (const t of own) lines.push(`| ${t.project} | ${cell(t.title)} | ${cell(brief(t.error))} |`);
};
listed("unexpected", "Failed");
// A retry passed: the test is not reliable, and the nightly gate fails on it (GATE_FAIL_ON_FLAKY).
listed("flaky", "Flaky: failed, then passed on the retry");
if (artifact && tests.some((t) => t.status === "unexpected" || t.status === "flaky")) {
  lines.push("", `Pictures, page snapshots and traces: the artifact \`${artifact}\` (\`npm run ci:failure -- <run id>\` fetches it).`);
}

const skips = Object.entries(Object.groupBy(tests.filter((t) => t.status === "skipped"), (t) => t.skip)).sort((a, b) => b[1].length - a[1].length);
if (skips.length) {
  lines.push("", "### Skipped, by reason", "", "| Tests | Reason |", "|---|---|");
  for (const [reason, own] of skips) lines.push(`| ${own.length} | ${cell(reason)} |`);
}

const slowest = tests.filter((t) => t.status !== "skipped").sort((a, b) => b.seconds - a.seconds).slice(0, 5);
if (slowest.length) {
  lines.push("", "### Slowest", "", "| Seconds | Project | Test |", "|---|---|---|");
  for (const t of slowest) lines.push(`| ${t.seconds.toFixed(0)} | ${t.project} | ${cell(t.title)} |`);
}

console.log(lines.join("\n"));
