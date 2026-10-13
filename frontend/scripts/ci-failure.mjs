// What failed in CI, on this machine: the failed jobs of a run, the tests that failed in its browser jobs, and the
// picture and page snapshot Playwright kept for each.
//
//   npm run ci:failure                   the latest CI run of the branch that is checked out
//   npm run ci:failure -- 26             the latest CI run of pull request 26
//   npm run ci:failure -- 38303520954    that run
//
// CI keeps a browser job's test results only when the job failed (ci.yml). They are downloaded to a new folder under
// the system's temporary folder, never into the checkout. Needs the GitHub CLI, signed in.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const gh = (...args) => JSON.parse(run("gh", args));
const plain = (text) => String(text).replace(/\u001b\[[0-9;]*m/g, "");

const asked = process.argv[2];
let runId = asked && /^\d{9,}$/.test(asked) ? asked : null;
if (!runId) {
  const branch = asked ? gh("pr", "view", asked, "--json", "headRefName").headRefName : run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const [latest] = gh("run", "list", "--workflow", "CI", "--branch", branch, "--limit", "1", "--json", "databaseId");
  if (!latest) {
    console.error(`No CI run for ${branch}.`);
    process.exit(1);
  }
  runId = String(latest.databaseId);
}

const { jobs, headSha, url } = gh("run", "view", runId, "--json", "jobs,headSha,url");
const failed = jobs.filter((job) => job.conclusion === "failure");
const waiting = jobs.filter((job) => job.status !== "completed").length;
console.log(`${url}\ncommit ${headSha.slice(0, 7)}: ${failed.length} failed of ${jobs.length} jobs${waiting ? `, ${waiting} still running` : ""}`);

/**
 * Every test of a Playwright JSON report whose outcome was not the expected one: a failure, a test marked to fail that
 * passed, and a flaky one. A test marked to fail that failed is as expected, and is not listed.
 */
function failures(suite, found = []) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests) {
      const result = test.results.at(-1);
      if (result && ["unexpected", "flaky"].includes(test.status)) found.push({ spec, test, result });
    }
  }
  for (const child of suite.suites ?? []) failures(child, found);
  return found;
}

for (const job of failed) {
  console.log(`\n== ${job.name}`);
  const browser = /^frontend-browser \((\S+) (\d+)\/\d+\)$/.exec(job.name);
  if (!browser) {
    console.log(`   gh run view ${runId} --job ${job.databaseId} --log-failed`);
    continue;
  }
  const folder = mkdtempSync(join(tmpdir(), `ci-failure-${runId}-${browser[1]}-${browser[2]}-`));
  try {
    run("gh", ["run", "download", runId, "-n", `frontend-browser-results-${browser[1]}-${browser[2]}`, "-D", folder]);
  } catch (error) {
    // The download's own words: results that are gone and a sign-in that has lapsed are different things to do.
    console.log(`   The job's results could not be downloaded: ${plain(error.stderr ?? error.message).trim().split("\n").at(-1)}`);
    console.log(`   gh run view ${runId} --job ${job.databaseId} --log-failed`);
    continue;
  }
  const report = join(folder, "results.json");
  if (!existsSync(report)) {
    console.log(`   No results.json in ${folder}.`);
    continue;
  }
  const found = JSON.parse(readFileSync(report, "utf8")).suites.flatMap((suite) => failures(suite));
  for (const { spec, test, result } of found) {
    const outcome = test.status === "flaky" ? "flaky" : result.status === "passed" ? "passed, and was marked to fail" : result.status;
    console.log(`\n   [${test.projectName}] ${spec.file}:${spec.line} › ${spec.title} (${outcome})`);
    // Every error of the last attempt (a soft assertion leaves several), each at its first lines.
    for (const error of result.errors?.length ? result.errors : [result.error ?? {}]) {
      const message = plain(error.message ?? "").split("\n").filter((line) => line.trim()).slice(0, 6);
      for (const line of message) console.log(`     ${line.trim()}`);
    }
    for (const attachment of result.attachments ?? []) {
      // The runner's path, from its test-results folder on, is the path inside the download.
      const kept = attachment.path?.split("/test-results/")[1];
      if (kept && existsSync(join(folder, kept))) console.log(`     ${attachment.name}: ${join(folder, kept)}`);
    }
  }
  if (found.length === 0) console.log(`   No failed test in the report: ${folder}`);
}
