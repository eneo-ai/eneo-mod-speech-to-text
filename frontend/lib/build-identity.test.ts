import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { buildView, SOURCE_REPOSITORY, supportText } from "./build-identity";

const REVISION = "c5d54608d5833737677157bde44b95b969e67bbb";
const COMMIT_PAGE = `https://github.com/eneo-ai/eneo-mod-speech-to-text/commit/${REVISION}`;
// The backend says when it was built in UTC; the page says it in the reader's own time, whatever the test machine's is.
const BUILT = new Date(2026, 9, 8, 10, 4, 12).toISOString();

test("a release shows the release, the commit's first seven characters with its page on GitHub, and when it was built", () => {
  assert.deepEqual(buildView({ release: "v0.1.0", revision: REVISION, build_date: BUILT }), {
    release: "v0.1.0",
    commit: "c5d5460",
    commitUrl: COMMIT_PAGE,
    built: "8 okt 2026 10:04",
  });
});

test("a build that no release names is a development version, known by its commit", () => {
  assert.deepEqual(buildView({ release: null, revision: REVISION, build_date: BUILT }), {
    release: "Utvecklingsversion",
    commit: "c5d5460",
    commitUrl: COMMIT_PAGE,
    built: "8 okt 2026 10:04",
  });
});

test("a build with nothing known says so: a development version with no commit, no link and no time", () => {
  assert.deepEqual(buildView({ release: null, revision: null, build_date: null }), {
    release: "Utvecklingsversion",
    commit: null,
    commitUrl: null,
    built: null,
  });
});

test("the support text is plain lines: the product, every value whole as the backend gave it, and the page's own address", () => {
  assert.equal(
    supportText({ release: "v0.1.0", revision: REVISION, build_date: "2026-10-08T08:04:12Z" }, "https://transkribering.example.org"),
    ["Tal till text", "Utgåva: v0.1.0", `Commit: ${REVISION}`, "Byggd: 2026-10-08T08:04:12Z", "Adress: https://transkribering.example.org"].join("\n"),
  );
  assert.equal(
    supportText({ release: null, revision: null, build_date: null }, "http://localhost:3002"),
    ["Tal till text", "Utgåva: utvecklingsversion", "Commit: okänd", "Byggd: okänd", "Adress: http://localhost:3002"].join("\n"),
  );
});

test("the repository is the one the image's source label names", () => {
  const dockerfile = readFileSync(join(__dirname, "..", "..", "..", "Dockerfile"), "utf8");
  assert.equal(/org\.opencontainers\.image\.source="([^"]+)"/.exec(dockerfile)?.[1], SOURCE_REPOSITORY);
});
