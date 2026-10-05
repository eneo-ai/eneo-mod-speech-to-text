import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, getRunStatus, REQUEST_TIMEOUT_MS, startRun } from "./api";
import { errorAdvice } from "./errors";

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A module that accepts the request and never answers; it ends the request only when the page does. */
function silentModule(t: import("node:test").TestContext) {
  const signals: AbortSignal[] = [];
  t.mock.method(globalThis, "fetch", (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal;
    signals.push(signal);
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    });
  });
  return signals;
}

test("a request that is not answered in time fails as a timeout, in words, which trying again can help", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  silentModule(t);
  const status = getRunStatus("flow-1", "run-1");
  const failed = assert.rejects(status, (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 408);
    assert.equal(error.code, "request_timed_out");
    assert.deepEqual(errorAdvice(error), { message: "Det tog för lång tid att få svar. Försök igen.", retry: true, ownerMustFix: false });
    return true;
  });
  await settle();
  t.mock.timers.tick(REQUEST_TIMEOUT_MS - 1);
  await settle();
  t.mock.timers.tick(1);
  await failed;
});

test("a request the page itself aborts is an abort, not a timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signals = silentModule(t);
  const own = new AbortController();
  const status = startRun("flow-1", {}, "key-1", own.signal);
  void status.catch(() => undefined);
  await settle();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false);
  own.abort();
  await assert.rejects(status, (error: unknown) => !(error instanceof ApiError));
  t.mock.timers.tick(2 * REQUEST_TIMEOUT_MS);
  await settle();
});

test("a request that is answered leaves no timer behind", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signals: AbortSignal[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    signals.push(init?.signal as AbortSignal);
    return new Response(JSON.stringify({ id: "run-1", flow_id: "flow-1", status: "running" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.equal((await getRunStatus("flow-1", "run-1")).status, "running");
  t.mock.timers.tick(REQUEST_TIMEOUT_MS);
  assert.equal(signals[0].aborted, false, "the answered request is not aborted afterwards");
});
