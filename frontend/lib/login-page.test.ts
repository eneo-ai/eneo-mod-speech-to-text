import assert from "node:assert/strict";
import test, { afterEach, type TestContext } from "node:test";

import { button, cleanup, installDom, mount } from "./test-dom";
import { withRouter } from "./test-router";

installDom();
afterEach(cleanup);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const signedOut = () => json({ authenticated: false, user: null });

/** The sign-in page under the providers every page has, with its server's answers and the router that says where it went. */
async function openLoginPage(t: TestContext, answers: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const { createElement } = await import("react");
  const { ModuleProviders } = await import("@/kit/ModuleProviders");
  const { default: LoginPage } = await import("../routes/LoginPage");
  const requests: string[] = [];
  const browserFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${url}`);
    return answers(url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = browserFetch;
    window.history.replaceState(null, "", "/");
  });
  // The page reads the address from the window, as in the browser, where the router writes it: a memory router does not,
  // so the entry it starts at is the window's too.
  const { router, tree } = withRouter(createElement(ModuleProviders, { children: createElement(LoginPage) }), {
    entries: [`${window.location.pathname}${window.location.search}`],
  });
  const view = await mount(tree);
  // The page asks who is signed in first; let that answer land.
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  return { ...view, requests, router };
}

const alerts = (within: ParentNode) => [...within.querySelectorAll('[role="alert"]')].map((element) => element.textContent ?? "");

test("while the session is asked for, the page is the shell's one main region, headed Tal till text, with a spinner that says so", async (t) => {
  const { container } = await openLoginPage(t, () => new Promise<Response>(() => {}));
  assert.equal(container.querySelectorAll('main, [role="main"]').length, 1, "one main region");
  assert.deepEqual([...container.querySelectorAll("h1")].map((heading) => heading.textContent), ["Tal till text"]);
  assert.ok(container.querySelector('[role="status"]'), "something says that it is loading");
  assert.match(container.textContent ?? "", /Hoppa till innehåll/, "the shell's skip link");
  assert.ok(container.querySelector('nav[aria-label="Tal till text"]'), "the shell's named navigation landmark");
});

test("the Eneo sign-in page asks for one thing, and pressing it says that Eneo opens and cannot be pressed twice", async (t) => {
  const { container, act } = await openLoginPage(t, signedOut);
  assert.deepEqual([...container.querySelectorAll("h1")].map((heading) => heading.textContent), ["Gör samtal och filer till text och dokument."]);
  assert.match(container.textContent ?? "", /Logga in via Eneo för att fortsätta\./);
  assert.equal(container.querySelectorAll("input").length, 0, "no field");
  assert.equal(container.querySelectorAll('main, [role="main"]').length, 1, "one main region");
  // jsdom cannot navigate; the page leaving for Eneo is what it logs.
  t.mock.method(console, "error", () => undefined);
  await act(async () => button(container, "Logga in med Eneo")!.click());
  const opening = button(container, "Öppnar Eneo…");
  assert.ok(opening, "says that Eneo opens");
  assert.ok(opening.disabled || opening.getAttribute("aria-disabled") === "true", "cannot be pressed twice");
});

test("Eneo's login is the only way in: no field, no form, and nothing is sent but the question who is signed in", async (t) => {
  const { container, requests } = await openLoginPage(t, signedOut);
  assert.equal(container.querySelectorAll("input, form").length, 0, "nothing to type into");
  assert.ok(button(container, "Logga in med Eneo"));
  assert.doesNotMatch(container.textContent ?? "", /åtkomstkod/i);
  assert.deepEqual(requests, ["GET /api/auth/status"]);
});

test("someone already signed in goes straight on to the flow list", async (t) => {
  const { router } = await openLoginPage(t, () => json({ authenticated: true, user: { id: "u", email: "a@b.se", username: "A" } }));
  assert.equal(router.state.location.pathname, "/flows");
  assert.equal(router.state.historyAction, "REPLACE");
});

test("Eneo's refusal of the sign-in is said, and the address is cleaned of it", async (t) => {
  window.history.replaceState(null, "", "/?auth_error=1");
  const { container, router } = await openLoginPage(t, signedOut);
  assert.deepEqual(alerts(document.body).filter((text) => text.includes("Inloggningen")), ["Inloggningen kunde inte slutföras. Försök igen."]);
  assert.equal(router.state.location.search, "", "the router has the address without it");
  assert.equal(router.state.historyAction, "REPLACE", "in place: Back does not return to the refusal");
  assert.ok(button(container, "Logga in med Eneo"), "the way in is still there");
});

test("a module that cannot be reached is said, with a way to try again and nothing to fill in", async (t) => {
  const { container } = await openLoginPage(t, () => Promise.reject(new TypeError("Failed to fetch")));
  assert.deepEqual(alerts(document.body).filter((text) => text.includes("kan inte nås")), ["Tal till text kan inte nås just nu."]);
  assert.ok(button(container, "Försök igen"));
  assert.equal(container.querySelectorAll("input").length, 0);
  assert.equal(container.querySelectorAll('main, [role="main"]').length, 1, "one main region");
});

test("coming Back from Eneo, with the page restored from the browser's cache, the sign-in can be pressed again", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const { container, act } = await openLoginPage(t, signedOut);
  await act(async () => button(container, "Logga in med Eneo")!.click());
  assert.ok(button(container, "Öppnar Eneo…"), "pressed: Eneo opens");

  // A page that is shown again from the cache has the state it left with; one that was loaded anew is not this event.
  await act(async () => void window.dispatchEvent(new window.PageTransitionEvent("pageshow", { persisted: false })));
  assert.ok(button(container, "Öppnar Eneo…"), "a pageshow of a new load changes nothing");
  await act(async () => void window.dispatchEvent(new window.PageTransitionEvent("pageshow", { persisted: true })));
  const again = button(container, "Logga in med Eneo");
  assert.ok(again, "the way in is back");
  assert.ok(!again.disabled && again.getAttribute("aria-disabled") !== "true", "and can be pressed");
});
