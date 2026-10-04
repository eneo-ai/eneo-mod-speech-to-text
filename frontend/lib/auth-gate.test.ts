import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { cleanup, installDom, mount } from "./test-dom";
import { withRouter } from "./test-router";

installDom();
afterEach(cleanup);

const settle = () => new Promise((resolve) => setImmediate(resolve));
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const anna = { id: "user-1", email: "anna@example.se", username: "Anna Berg" };
const signedIn = { authenticated: true, user: anna, session_ends_in: 8 * 3600 };

test("a status read that went out while signed in, answered after a request found the login ended, does not uncover the page", async (t) => {
  const { createElement } = await import("react");
  const { AuthGate } = await import("../components/AuthGate");
  const { loginState } = await import("./login-state");

  const held: Array<(response: Response) => void> = [];
  let reads = 0;
  const browserFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (!String(url).startsWith("/api/auth/status")) return json({});
    reads += 1;
    return reads === 1 ? json(signedIn) : new Promise<Response>((resolve) => held.push(resolve));
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = browserFetch;
  });

  const { container, act } = await mount(withRouter(createElement(AuthGate, null, createElement("p", null, "Sidan")), { path: "/flows/:id", entries: ["/flows/a"] }).tree);
  for (let i = 0; i < 10 && !container.textContent?.includes("Sidan"); i += 1) await act(settle);
  assert.ok(container.textContent?.includes("Sidan"), "the page is shown once the first read says signed in");
  assert.equal(loginState.signedOut, false);

  // A read goes out while signed in (the page became visible), and is slow.
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  assert.equal(held.length, 1, "the second read is out");
  // Meanwhile a request finds the login ended: the page is covered.
  await act(async () => loginState.ended());
  assert.equal(loginState.signedOut, true);

  // The slow read answers "signed in", from before the end.
  await act(async () => held[0](json(signedIn)));
  await act(settle);
  assert.equal(loginState.signedOut, true, "the page stays covered");
  assert.equal(container.querySelector("[inert]") !== null, true, "and out of reach");
});

test("a login window that tells the session channel it is done confirms a new login the page never showed as ended: what is still out on the old session is stale", async (t) => {
  const { createElement } = await import("react");
  const { AuthGate } = await import("../components/AuthGate");
  const { SESSION_CHANNEL } = await import("../components/SessionEndWarning");
  const { getRunStatus } = await import("./api");
  const { loginState } = await import("./login-state");

  const sessionEnded = () =>
    new Response(JSON.stringify({ detail: "Session expired" }), {
      status: 401,
      headers: { "content-type": "application/json", "X-Auth-Required": "session" },
    });
  // Node's own BroadcastChannel will not deliver to jsdom's Event, so the channel is a small stand-in for the
  // browser's: a message goes to the other channels of the same name.
  const open = new Set<{ name: string; listeners: Set<() => void> }>();
  class FakeChannel {
    listeners = new Set<() => void>();
    constructor(public name: string) {
      open.add(this);
    }
    addEventListener(_type: string, listener: () => void) {
      this.listeners.add(listener);
    }
    postMessage() {
      for (const other of open) if (other !== this && other.name === this.name) other.listeners.forEach((listener) => listener());
    }
    close() {
      open.delete(this);
    }
  }
  const browserChannel = globalThis.BroadcastChannel;
  globalThis.BroadcastChannel = FakeChannel as unknown as typeof BroadcastChannel;
  const held: Array<(response: Response) => void> = [];
  let reads = 0;
  const browserFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).startsWith("/api/auth/status")) {
      reads += 1;
      return json(signedIn);
    }
    return String(url).startsWith("/api/eneo/") ? new Promise<Response>((resolve) => held.push(resolve)) : json({});
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = browserFetch;
    globalThis.BroadcastChannel = browserChannel;
  });

  const { container, act } = await mount(withRouter(createElement(AuthGate, null, createElement("p", null, "Sidan")), { path: "/flows/:id", entries: ["/flows/a"] }).tree);
  for (let i = 0; i < 10 && !container.textContent?.includes("Sidan"); i += 1) await act(settle);
  assert.equal(reads, 1);
  const reading = getRunStatus("flow-1", "run-1"); // out on the old session
  await act(settle);
  assert.equal(held.length, 1);

  // The same person signs in again early, in a window of their own: it replaces the session, and tells the channel.
  const channel = new BroadcastChannel(SESSION_CHANNEL);
  await act(async () => channel.postMessage("inloggad"));
  channel.close();
  await act(settle);
  assert.equal(reads, 2, "the page reads the status again");

  // The old session is gone: the marked 401 of what went out on it arrives.
  await act(async () => held[0](sessionEnded()));
  await act(settle);
  assert.equal(loginState.signedOut, false, "the renewed page is not covered");
  assert.equal(held.length, 2, "and the read goes again under the new login");
  await act(async () => held[1](json({ id: "run-1", flow_id: "flow-1", status: "running" })));
  assert.equal((await reading).id, "run-1");
});

test("a navigation that keeps the page mounted does not make AuthGate read the session again: the router's navigate is one function", async (t) => {
  const { createElement } = await import("react");
  const { AuthGate } = await import("../components/AuthGate");
  let reads = 0;
  const browserFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).startsWith("/api/auth/status")) reads += 1;
    return String(url).startsWith("/api/auth/status") ? json(signedIn) : json({});
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = browserFetch;
  });
  // A route with a parameter: another flow is another address of the same page, which stays mounted.
  const { router, tree } = withRouter(createElement(AuthGate, null, createElement("p", null, "Sidan")), { path: "/flows/:id", entries: ["/flows/a"] });
  const { container, act } = await mount(tree);
  for (let i = 0; i < 10 && !container.textContent?.includes("Sidan"); i += 1) await act(settle);
  assert.equal(reads, 1, "one read on arrival");
  await act(async () => router.navigate("/flows/b"));
  await act(settle);
  await act(async () => router.navigate({ search: "?run=r1" }, { replace: true }));
  await act(settle);
  assert.equal(router.state.location.pathname, "/flows/b", "the router moved");
  assert.ok(container.textContent?.includes("Sidan"), "the page stayed");
  assert.equal(reads, 1, "and the session was not read again: the effect did not run again, nor the keep-alive restart");
});
