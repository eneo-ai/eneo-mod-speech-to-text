import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, authStatus, cancelRun, getConfig, getRunStatus, startRun, uploadStepRuntimeFile, type AuthenticatedUser, type AuthStatus } from "./api";
import { loginState } from "./login-state";
import { ACCESS_CODE_USER } from "./user-identity";

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
function signedInPage(t: import("node:test").TestContext, answers: Array<() => Response>, owner: AuthenticatedUser = anna) {
  const calls: Array<{ url: string; method: string; headers: Headers }> = [];
  const browserFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", headers: new Headers(init?.headers) });
    return (answers.shift() ?? (() => ok({})))();
  }) as typeof fetch;
  const navigated: string[] = [];
  const page = globalThis as { window?: unknown };
  const browserWindow = page.window;
  page.window = { location: { pathname: "/flows/flow-1", replace: (url: string) => navigated.push(url) } };
  const end = loginState.begin(owner);
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

// A browser has one cookie for every tab: after someone else signs in in another tab, this page's requests would
// carry their login. The module compares the user the page names with the session's and answers 409 user_changed.
const userChanged = () =>
  new Response(JSON.stringify({ detail: "user_changed" }), {
    status: 409,
    headers: { "content-type": "application/json" },
  });

/** An XMLHttpRequest that answers `httpStatus` and `body`, and keeps the headers it was sent with and how often it sent. */
function answeringXhr(t: import("node:test").TestContext, httpStatus: number, body: unknown) {
  const sent = { headers: {} as Record<string, string>, count: 0 };
  class AnsweringXhr {
    upload = {};
    onload: (() => void) | null = null;
    onerror = null;
    onabort = null;
    withCredentials = false;
    status = httpStatus;
    responseText = JSON.stringify(body);
    open() {}
    setRequestHeader(name: string, value: string) {
      sent.headers[name.toLowerCase()] = value;
    }
    abort() {}
    getResponseHeader(name: string) {
      return name.toLowerCase() === "content-type" ? "application/json" : null;
    }
    send() {
      sent.count += 1;
      queueMicrotask(() => this.onload?.());
    }
  }
  const browserXhr = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = AnsweringXhr as unknown as typeof XMLHttpRequest;
  t.after(() => {
    globalThis.XMLHttpRequest = browserXhr;
  });
  return sent;
}

test("a page names its user while it is open, and nobody once it is gone", () => {
  assert.equal(loginState.expectedUser, null);
  const end = loginState.begin(anna);
  assert.equal(loginState.expectedUser, "user-1");
  end();
  assert.equal(loginState.expectedUser, null);
});

test("every request to Eneo names the page's user, and the module's own requests do not", async (t) => {
  const { calls } = signedInPage(t, []);
  await getRunStatus("flow-1", "run-1");
  await startRun("flow-1", { expected_flow_version: 1 }, "flow-run:recording:r1");
  await getConfig();
  await authStatus();
  assert.deepEqual(
    calls.map((call) => call.headers.get("X-Expected-User")),
    ["user-1", "user-1", null, null],
  );
});

test("the access code has no user to name", async (t) => {
  const { calls } = signedInPage(t, [], ACCESS_CODE_USER);
  await getRunStatus("flow-1", "run-1");
  assert.equal(calls[0].headers.has("X-Expected-User"), false);
});

test("an upload names the page's user", async (t) => {
  signedInPage(t, []);
  const sent = answeringXhr(t, 200, { id: "file-1" });
  await uploadStepRuntimeFile("flow-1", "step-audio", new Blob(["a"]), "a.webm");
  assert.equal(sent.headers["x-expected-user"], "user-1");
});

test("another user's login under this page covers it, and nothing is sent again by the page, not even what is safe to repeat", async (t) => {
  const { calls } = signedInPage(t, [userChanged, () => ok({ id: "run-1", flow_id: "flow-1", status: "queued" })]);
  await assert.rejects(
    startRun("flow-1", { expected_flow_version: 1 }, "flow-run:recording:r1"),
    (error: ApiError) => error.status === 401 && error.code === undefined,
  );
  assert.equal(loginState.signedOut, true, "the page is covered");
  loginState.observe(signedIn()); // the page's own user is back
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, "the run start is not sent again");
});

test("a user change reads the status again, which says who is signed in instead; the page's own user back uncovers it", async (t) => {
  let reread = 0;
  const end = loginState.begin(anna, () => (reread += 1));
  t.after(end);
  loginState.userChanged();
  assert.equal(loginState.signedOut, true);
  assert.equal(reread, 1);
  loginState.observe(signedIn(8 * 3600, erik)); // what the status said
  assert.deepEqual(loginState.otherUser, erik);
  loginState.observe(signedIn());
  assert.equal(loginState.signedOut, false);
});

test("a user change with no way to read the status again still covers the page", (t) => {
  t.after(loginState.begin(anna));
  loginState.userChanged();
  assert.equal(loginState.signedOut, true);
});

test("an upload for another user's session covers the page and is not sent again, whoever signs in next", async (t) => {
  signedInPage(t, []);
  const sent = answeringXhr(t, 409, { detail: "user_changed" });
  await assert.rejects(uploadStepRuntimeFile("flow-1", "step-audio", new Blob(["a"]), "a.webm"), (error: ApiError) => error.status === 401);
  assert.equal(loginState.signedOut, true);
  loginState.observe(signedIn());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.count, 1);
});

test("any other 409 is an ordinary error and covers nothing", async (t) => {
  signedInPage(t, [
    () => new Response(JSON.stringify({ code: "revision_conflict", detail: "Changed." }), { status: 409, headers: { "content-type": "application/json" } }),
  ]);
  await assert.rejects(cancelRun("flow-1", "run-1"), (error: ApiError) => error.status === 409 && error.code === "revision_conflict");
  assert.equal(loginState.signedOut, false);
});
