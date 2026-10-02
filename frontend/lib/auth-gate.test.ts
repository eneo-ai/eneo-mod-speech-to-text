import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { cleanup, installDom, mount } from "./test-dom";

installDom();
afterEach(cleanup);

// AuthGate asks Next's router only to leave for the start page, which these tests never need. The router is one
// object, as Next's is: AuthGate's effect depends on it.
const router = { replace() {}, push() {} };
const navigation = require.resolve("next/navigation");
require.cache[navigation] = {
  id: navigation,
  filename: navigation,
  loaded: true,
  exports: { useRouter: () => router },
} as unknown as NodeModule;

const settle = () => new Promise((resolve) => setImmediate(resolve));
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const anna = { id: "user-1", email: "anna@example.se", username: "Anna Berg" };
const signedIn = { authenticated: true, auth_mode: "eneo_sso", user: anna, session_ends_in: 8 * 3600 };

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

  const { container, act } = await mount(createElement(AuthGate, null, createElement("p", null, "Sidan")));
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
