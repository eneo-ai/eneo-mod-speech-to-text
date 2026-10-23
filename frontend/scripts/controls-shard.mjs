// The --grep of one CI shard of controls.spec.ts, balanced by how long each test takes rather than by how many there are.
//
//   filter=$(node scripts/controls-shard.mjs 2/5 --project=a --project=b)
//   npx playwright test controls.spec.ts --project=a --project=b --grep="$filter"
//
// Playwright's own --shard cuts the ordered list into blocks of equal count, so the projects whose states take longest
// share a shard and set the length of the whole run. Here every test the projects run (`--list`) goes, longest first, to
// the shard with the least time so far (tests/e2e/controls-weights.json: seconds per "<project> <state>", from a CI run's
// results.json; a test it does not know weighs as the median). Every test is in exactly one shard: the script checks it,
// and fails rather than print an empty filter. CI runs it in a step of its own, so that a failure fails the job.
// Refresh the weights from the `frontend-browser-timings-controls-*` artifacts when states are added or the shards drift.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [shard, ...projects] = process.argv.slice(2);
const match = /^(\d+)\/(\d+)$/.exec(shard ?? "");
if (!match || !projects.length || projects.some((p) => !p.startsWith("--project="))) {
  console.error("usage: node scripts/controls-shard.mjs <n>/<total> --project=<name>...");
  process.exit(2);
}
const [current, total] = [Number(match[1]), Number(match[2])];

// The JSON report on stdout: CI's jobs send it to a file (PLAYWRIGHT_JSON_OUTPUT_NAME), which would leave stdout without it.
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PLAYWRIGHT_JSON_OUTPUT_")));
const listed = JSON.parse(
  execFileSync("npx", ["playwright", "test", "controls.spec.ts", "--list", "--reporter=json", ...projects], { encoding: "utf8", env, stdio: ["ignore", "pipe", "inherit"] }),
);
const tests = [];
const walk = (suite) => {
  for (const spec of suite.specs ?? []) {
    const state = /^every control of (.+) does something$/.exec(spec.title)?.[1];
    if (!state) throw new Error(`controls.spec.ts has a test this script does not know: ${spec.title}`);
    for (const test of spec.tests) tests.push({ project: test.projectName, state });
  }
  (suite.suites ?? []).forEach(walk);
};
listed.suites.forEach(walk);

const weights = JSON.parse(readFileSync(new URL("../tests/e2e/controls-weights.json", import.meta.url), "utf8"));
const known = Object.values(weights).sort((a, b) => a - b);
const median = known[Math.floor(known.length / 2)] ?? 1;
const weight = (test) => weights[`${test.project} ${test.state}`] ?? median;

const shards = Array.from({ length: total }, () => ({ seconds: 0, tests: [] }));
for (const test of [...tests].sort((a, b) => weight(b) - weight(a) || `${a.project} ${a.state}`.localeCompare(`${b.project} ${b.state}`))) {
  const lightest = shards.reduce((min, s) => (s.seconds < min.seconds ? s : min));
  lightest.seconds += weight(test);
  lightest.tests.push(test);
}
const placed = shards.flatMap((s) => s.tests.map((t) => `${t.project} ${t.state}`));
if (placed.length !== tests.length || new Set(placed).size !== tests.length) throw new Error("a test is in no shard or in two");

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mine = shards[current - 1]?.tests ?? [];
// An empty --grep matches every test: a shard with none fails rather than run them all.
if (!mine.length) throw new Error(`controls shard ${current}/${total} has no test: ${tests.length} tests in ${total} shards`);
const byProject = Object.entries(Object.groupBy(mine, (t) => t.project));
console.error(`controls shard ${current}/${total}: ${mine.length} tests, about ${shards[current - 1].seconds} s of ${shards.map((s) => s.seconds).join(" / ")}`);
// Playwright matches --grep against "<project> <file> <title>".
console.log(byProject.map(([project, own]) => `${escape(project)} .*every control of (${own.map((t) => escape(t.state)).join("|")}) does something$`).join("|"));
