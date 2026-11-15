import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";

import { ApiError, authStatus, getRunStatus, REQUEST_TIMEOUT_MS, startRun } from "./api";
import { loginState } from "./login-state";
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

/**
 * A module that sends its headers and the start of its body, then goes quiet. The body ends when the request's signal
 * does, as a browser's fetch ends it.
 */
function stalledBody(t: import("node:test").TestContext, status: number) {
  const signals: AbortSignal[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal;
    signals.push(signal);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"authenticated":'));
        signal.addEventListener("abort", () => controller.error(signal.reason));
      },
    });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  });
  return signals;
}

for (const status of [200, 500]) {
  test(`a request the page lets go after a ${status} answer began ends its body's read too, as an abort`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const signals = stalledBody(t, status);
    const own = new AbortController();
    const asked = authStatus(own.signal);
    const outcome = asked.then(
      () => "answered",
      (error: unknown) => error,
    );
    await settle();
    assert.equal(signals.length, 1);
    // The headers have come: the time limit is over (it is for an answer that never begins), and nothing else ends it.
    t.mock.timers.tick(2 * REQUEST_TIMEOUT_MS);
    await settle();
    assert.equal(signals[0].aborted, false, "a body on its way is not a timeout");
    own.abort();
    await settle();
    assert.equal(signals[0].aborted, true, "the page's abort reaches the body's read");
    const error = await outcome;
    assert.ok(!(error instanceof ApiError), `an abort, not the answer's error: ${String(error)}`);
    assert.equal((error as Error).name, "AbortError");
  });
}

test("requests on one long-lived signal leave none of their listeners on it, also while one waits for a new login", async (t) => {
  const own = new AbortController();
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ authenticated: true, user: null }), { status: 200, headers: { "content-type": "application/json" } }),
  );
  for (let i = 0; i < 3; i += 1) await authStatus(own.signal);
  assert.equal(getEventListeners(own.signal, "abort").length, 0, "answered requests keep no listener");

  // A replayable request our login's end refused waits for the new login, with only that wait's own listener.
  t.after(loginState.begin({ id: "user-1", email: "anna@example.se" }, () => undefined));
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ detail: "Session expired" }), {
      status: 401,
      headers: { "content-type": "application/json", "X-Auth-Required": "session" },
    }),
  );
  const waiting = startRun("flow-1", {}, "key-1", own.signal);
  void waiting.catch(() => undefined);
  for (let i = 0; i < 5 && !loginState.signedOut; i += 1) await settle();
  assert.equal(loginState.signedOut, true);
  await settle();
  assert.equal(getEventListeners(own.signal, "abort").length, 1, "the request's own listener is gone before the wait");
  own.abort();
  await assert.rejects(waiting);
});
