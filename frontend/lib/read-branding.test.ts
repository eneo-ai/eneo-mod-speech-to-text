import assert from "node:assert/strict";
import test from "node:test";

import { readBranding } from "./read-branding";

const quiet = () => {
  const original = console.error;
  console.error = () => {};
  return () => (console.error = original);
};

test("a backend that stalls gives the product name alone once the deadline passes", async () => {
  const restore = quiet();
  // Answers only when aborted, like a backend that accepts the connection and never replies.
  const stalled: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
  // AbortSignal.timeout does not keep Node's event loop alive; a browser or server request would.
  const keepAlive = setTimeout(() => {}, 5_000);
  const started = Date.now();
  const branding = await readBranding("http://backend", stalled, 50);
  clearTimeout(keepAlive);
  restore();
  assert.deepEqual(branding, { organization: null });
  assert.ok(Date.now() - started < 1_000, "the page is not held past the deadline");
});

test("a timely answer is the deployment's branding", async () => {
  const answer = { organization: { name: "Umeå kommun", logo: null } };
  const ok: typeof fetch = async () => new Response(JSON.stringify(answer), { status: 200 });
  assert.deepEqual(await readBranding("http://backend", ok, 50), answer);
});
