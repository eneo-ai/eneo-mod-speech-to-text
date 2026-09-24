import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, cancelRun, getRunStatus, startRun, uploadStepRuntimeFile, type AuthStatus } from "./api";
import { loginState } from "./login-state";

const sessionEnded = () =>
  new Response(JSON.stringify({ detail: "Session expired" }), {
    status: 401,
    headers: { "content-type": "application/json", "X-Auth-Required": "session" },
  });
const anna = { id: "user-1", email: "anna@example.se", username: "Anna Berg" };
const erik = { id: "user-2", email: "erik@example.se", username: "Erik Lund" };
const signedIn = (sessionEndsIn = 8 * 3600, user = anna): AuthStatus => ({
  authenticated: true,
  auth_mode: "eneo_sso",
  user,
  session_ends_in: sessionEndsIn,
});
const signedOut: AuthStatus = { authenticated: false, auth_mode: "eneo_sso", user: null };
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** A signed-in page (AuthGate) whose login ends at the first request, and whose navigations are recorded. */
function signedInPage(t: import("node:test").TestContext, answers: Array<() => Response>) {
  const calls: Array<{ url: string; method: string }> = [];
  const browserFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    return (answers.shift() ?? (() => ok({})))();
  }) as typeof fetch;
  const navigated: string[] = [];
  const page = globalThis as { window?: unknown };
  const browserWindow = page.window;
  page.window = { location: { pathname: "/flows/flow-1", replace: (url: string) => navigated.push(url) } };
  const end = loginState.begin(anna);
  t.after(() => {
    end();
    globalThis.fetch = browserFetch;
    page.window = browserWindow;
  });
  return { calls, navigated };
}

test("a session end never navigates away: the page stays signed out, and a read waits for the new login and goes again", async (t) => {
  const { calls, navigated } = signedInPage(t, [sessionEnded, () => ok({ id: "run-1", flow_id: "flow-1", status: "running" })]);
  const reading = getRunStatus("flow-1", "run-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loginState.signedOut, true, "the sign-in dialog opens over the page");
  assert.deepEqual(navigated, [], "nothing navigates, so a recording goes on");
  assert.equal(calls.length, 1, "the read waits");

  loginState.observe(signedIn());
  assert.equal((await reading).status, "running");
  assert.equal(loginState.signedOut, false);
  assert.equal(calls.length, 2, "sent again once");
});

test("a request sent again after the new login is sent again only once", async (t) => {
  const { calls } = signedInPage(t, [sessionEnded, sessionEnded]);
  const reading = getRunStatus("flow-1", "run-1");
  await new Promise((resolve) => setImmediate(resolve));
  loginState.observe(signedIn());
  await assert.rejects(reading, (error: ApiError) => error.status === 401);
  assert.equal(calls.length, 2);
});

test("a run request with its Idempotency-Key goes again after the new login; a request without one is the user's to repeat", async (t) => {
  const { calls } = signedInPage(t, [sessionEnded, () => ok({ id: "run-1", flow_id: "flow-1", status: "queued" }), sessionEnded]);
  const starting = startRun("flow-1", { expected_flow_version: 1 }, "flow-run:recording:r1");
  await new Promise((resolve) => setImmediate(resolve));
  loginState.observe(signedIn());
  assert.equal((await starting).id, "run-1");
  assert.deepEqual(calls.map((call) => call.method), ["POST", "POST"]);

  await assert.rejects(cancelRun("flow-1", "run-1"), (error: ApiError) => error.status === 401);
  assert.equal(loginState.signedOut, true, "and asks for the login");
  assert.equal(calls.length, 3, "not sent again by itself");
});

test("a wait ends when its request is cancelled", async (t) => {
  const { calls } = signedInPage(t, [sessionEnded]);
  const cancel = new AbortController();
  const starting = startRun("flow-1", { expected_flow_version: 1 }, "flow-run:recording:r1", cancel.signal);
  await new Promise((resolve) => setImmediate(resolve));
  cancel.abort(); // Avbryt, or the page going
  await assert.rejects(starting, (error: ApiError) => error.status === 401);
  assert.equal(calls.length, 1);
});

test("the start page, which no signed-in page holds, never waits for a login", async () => {
  const browserFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return sessionEnded();
  }) as typeof fetch;
  try {
    await assert.rejects(getRunStatus("flow-1", "run-1"), (error: ApiError) => error.status === 401);
    assert.equal(loginState.signedOut, false);
    assert.equal(calls, 1, "sent once, as before");
  } finally {
    globalThis.fetch = browserFetch;
  }
});

test("the login's end time or a status that says signed out ends it too; a status that says signed in renews it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const end = loginState.begin(anna);
  t.after(end);
  loginState.observe(signedIn(60));
  t.mock.timers.tick(59_000);
  assert.equal(loginState.signedOut, false);
  t.mock.timers.tick(1_000);
  assert.equal(loginState.signedOut, true, "the end time passed");
  loginState.observe(signedIn());
  assert.equal(loginState.signedOut, false);
  loginState.observe(signedOut);
  assert.equal(loginState.signedOut, true);
});

test("an upload the session end refused asks for the login, and is the user's to send again", async (t) => {
  class SessionEndedXhr {
    upload = { onprogress: null };
    onload: (() => void) | null = null;
    onerror = null;
    onabort = null;
    withCredentials = false;
    status = 401;
    responseText = JSON.stringify({ detail: "Session expired" });
    open() {}
    setRequestHeader() {}
    abort() {}
    getResponseHeader(name: string) {
      return name.toLowerCase() === "x-auth-required" ? "session" : "application/json";
    }
    send() {
      queueMicrotask(() => this.onload?.());
    }
  }
  signedInPage(t, []);
  const browserXhr = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = SessionEndedXhr as unknown as typeof XMLHttpRequest;
  t.after(() => {
    globalThis.XMLHttpRequest = browserXhr;
  });
  await assert.rejects(uploadStepRuntimeFile("flow-1", "step-audio", new Blob(["a"]), "a.webm"), (error: ApiError) => error.status === 401);
  assert.equal(loginState.signedOut, true);
});

test("someone else signing in here unlocks nothing: what waits is not sent as them, and goes once the page's own user is back", async (t) => {
  const { calls } = signedInPage(t, [sessionEnded, () => ok({ id: "run-1", flow_id: "flow-1", status: "running" })]);
  const reading = getRunStatus("flow-1", "run-1");
  await new Promise((resolve) => setImmediate(resolve));
  loginState.observe(signedIn(8 * 3600, erik));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loginState.signedOut, true, "the page stays covered");
  assert.deepEqual(loginState.otherUser, erik, "and says who is signed in instead");
  assert.equal(calls.length, 1, "nothing is sent again under Erik's login");

  loginState.observe(signedIn());
  assert.equal((await reading).status, "running");
  assert.equal(loginState.signedOut, false);
  assert.equal(loginState.otherUser, null);
  assert.equal(calls.length, 2);
});

test("while signed out nothing leaves the page: a read waits for the page's user, anything else is refused unsent", async (t) => {
  const { calls } = signedInPage(t, [() => ok({ id: "run-1", flow_id: "flow-1", status: "running" })]);
  loginState.observe(signedIn(8 * 3600, erik)); // someone else, whose login every request would carry
  await assert.rejects(cancelRun("flow-1", "run-1"), (error: ApiError) => error.status === 401);
  const reading = getRunStatus("flow-1", "run-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);
  loginState.observe(signedIn());
  assert.equal((await reading).status, "running");
  assert.deepEqual(calls.map((call) => call.method), ["GET"]);

  class CountingXhr {
    static sent = 0;
    upload = {};
    open() {}
    setRequestHeader() {}
    send() {
      CountingXhr.sent += 1;
    }
  }
  const browserXhr = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = CountingXhr as unknown as typeof XMLHttpRequest;
  t.after(() => {
    globalThis.XMLHttpRequest = browserXhr;
  });
  loginState.ended();
  await assert.rejects(uploadStepRuntimeFile("flow-1", "step-audio", new Blob(["a"]), "a.webm"), (error: ApiError) => error.status === 401);
  assert.equal(CountingXhr.sent, 0, "the upload is not sent either");
});
