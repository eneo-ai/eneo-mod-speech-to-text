import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// The module refuses a write to /api/eneo and a live socket that do not name the user their page was opened for
// (X-Expected-User, ?expected_user=). lib/api.ts and the live socket's address are the two places that add it, so a
// network call anywhere else is a call that goes out without it: it must be reviewed, and then listed here.
const root = path.join(__dirname, "../..");

const allowed: Record<string, string> = {
  "lib/api.ts": "request() and the upload's XMLHttpRequest name the user; every call to Eneo goes through them",
  "lib/live-transcriber.ts": "the live socket; its address names the user (liveSocketUrl)",
  "components/flow/live-audio.ts": "the live socket; browserLiveDeps gives it the user",
  "components/flow/ResultDocument.tsx": "a GET of the result file's own link, to share it: a read, not a write to Eneo",
};
const networkCall = /\bfetch\(|\bXMLHttpRequest\b|\bsendBeacon\b|\bWebSocket\b|\bEventSource\b/;

function sources(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sources(relative);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.(test|d)\.ts$/.test(entry.name) ? [relative] : [];
  });
}

const code = (file: string) =>
  readFileSync(path.join(root, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

test("no network call goes out from the page except through the code that names its user", () => {
  const found = [...["routes", "components", "lib", "kit"].flatMap(sources), "main.tsx", "routes.tsx"].filter((file) => networkCall.test(code(file)));
  const unlisted = found.filter((file) => !(file in allowed));
  assert.deepEqual(
    unlisted,
    [],
    "a network call outside lib/api.ts and the live socket goes out without X-Expected-User: send it through request() or name the user, then list the file in this test",
  );
});

test("lib/api.ts has one fetch and one XMLHttpRequest, both of which name the user", () => {
  const api = code("lib/api.ts");
  assert.equal(api.match(/\bfetch\(/g)?.length, 1, "a second fetch would bypass request()");
  assert.equal(api.match(/new XMLHttpRequest\(/g)?.length, 1, "a second upload would bypass the one that names the user");
  assert.equal(api.match(/expectedUserHeader\(\)/g)?.length, 3, "the definition, request() and the upload");
});
