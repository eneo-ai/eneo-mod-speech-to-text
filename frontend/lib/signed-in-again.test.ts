import assert from "node:assert/strict";
import test, { afterEach, type TestContext } from "node:test";

import { cleanup, installDom, mount } from "./test-dom";
import { withRouter } from "./test-router";

installDom();
afterEach(cleanup);

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** /inloggad as the router renders it at an address, with the backend's answers recorded and the window's closing stubbed. */
async function open(t: TestContext, address: string, answers: (url: string) => Response = () => json({ authenticated: true, user: { id: "u1", username: "Anna Berg", email: "anna@example.se" } })) {
  const { createElement } = await import("react");
  const { default: SignedInAgain } = await import("../routes/SignedInAgain");
  const requests: string[] = [];
  const browserFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    requests.push(String(url));
    return answers(String(url));
  }) as typeof fetch;
  const closed = t.mock.method(window, "close", () => undefined);
  const title = document.title;
  t.after(() => {
    globalThis.fetch = browserFetch;
    document.title = title;
  });
  const { router, tree } = withRouter(createElement(SignedInAgain), { path: "/inloggad", entries: [address] });
  const view = await mount(tree);
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  return { ...view, router, requests, closed };
}

const heading = (within: ParentNode) => within.querySelector("h1")?.textContent;

test("a login window that renewed the session tells the module's tabs and closes itself", async (t) => {
  // The channel the page speaks on, recorded: what a tab would hear.
  const heard: [string, unknown][] = [];
  const real = globalThis.BroadcastChannel;
  globalThis.BroadcastChannel = class {
    constructor(readonly name: string) {}
    postMessage(message: unknown) {
      heard.push([this.name, message]);
    }
    close() {}
  } as unknown as typeof BroadcastChannel;
  t.after(() => void (globalThis.BroadcastChannel = real));
  const { container, closed, requests } = await open(t, "/inloggad");
  assert.equal(heading(container), "Du är inloggad igen");
  assert.equal(document.title, "Inloggad igen · Tal till text");
  assert.equal(closed.mock.callCount(), 1, "the window closes");
  assert.deepEqual(heard, [["tal-till-text:session", "inloggad"]], "after telling the tabs");
  assert.deepEqual(requests, [], "it asks the backend nothing: there is no gate here");
});

test("a renewal that found the login already ended says so, keeps its window and keeps its title", async (t) => {
  const { container, closed, requests } = await open(t, "/inloggad?fel=utgangen");
  assert.equal(heading(container), "Inloggningen har redan gått ut");
  assert.equal(document.title, "Inloggningen har gått ut · Tal till text");
  assert.match(container.textContent ?? "", /stoppa den och välj Spara som fil/);
  assert.equal(closed.mock.callCount(), 0, "the window stays for the person to read");
  assert.deepEqual(requests, []);
});

test("a renewal that signed in someone else names the person to sign in as", async (t) => {
  const { container, closed, requests } = await open(t, "/inloggad?fel=annan-anvandare");
  assert.equal(heading(container), "Du loggade in som en annan användare");
  assert.equal(document.title, "Fel användare · Tal till text");
  assert.match(container.textContent ?? "", /logga in som Anna Berg för att fortsätta/);
  assert.equal(closed.mock.callCount(), 0);
  assert.deepEqual(requests, ["/api/auth/status"], "who the page's own login is, and nothing else");
});

test("a value of fel that the backend does not send is the plain page", async (t) => {
  const { container, closed } = await open(t, "/inloggad?fel=nagot-annat");
  assert.equal(heading(container), "Du är inloggad igen");
  assert.equal(document.title, "Inloggad igen · Tal till text");
  assert.equal(closed.mock.callCount(), 1);
});

test("the page is outside every gate: signed out or an unreachable backend, it does not leave", async (t) => {
  const { container, router } = await open(t, "/inloggad?fel=utgangen", () => {
    throw new TypeError("Failed to fetch");
  });
  assert.equal(heading(container), "Inloggningen har redan gått ut");
  assert.equal(router.state.location.pathname, "/inloggad", "no redirect to the sign-in page");
});
