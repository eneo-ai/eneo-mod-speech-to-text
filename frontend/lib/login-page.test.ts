import assert from "node:assert/strict";
import test, { afterEach, type TestContext } from "node:test";

import { button, cleanup, installDom, mount, type } from "./test-dom";
import { withRouter } from "./test-router";

installDom();
afterEach(cleanup);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const status = (auth_mode: "eneo_sso" | "access_code") => json({ authenticated: false, auth_mode, user: null });

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

/** The form control a person finds by its label, as the accessibility tree names it. */
function field(within: ParentNode, name: string): HTMLInputElement | null {
  return (
    [...within.querySelectorAll("input")].find((input) => {
      const named = (input.getAttribute("aria-labelledby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "");
      return [...named, ...[...(input.labels ?? [])].map((label) => label.textContent ?? "")].some((text) => text.trim().startsWith(name));
    }) ?? null
  );
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
  const { container, act } = await openLoginPage(t, () => status("eneo_sso"));
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

test("the access code field is a password field a password manager can fill, the browser can limit, and focus is in it on arrival", async (t) => {
  const { container } = await openLoginPage(t, () => status("access_code"));
  assert.match(container.textContent ?? "", /Ange åtkomstkoden för att fortsätta\./);
  const code = field(container, "Åtkomstkod");
  assert.ok(code, "a field named Åtkomstkod");
  assert.equal(code.type, "password");
  assert.equal(code.getAttribute("autocomplete"), "current-password", "WCAG 3.3.8: a password manager may fill it");
  assert.equal(code.required, true, "an empty code is stopped by the browser");
  assert.equal(code.maxLength, 256, "the backend's limit");
  assert.equal(code.hasAttribute("aria-errormessage"), false, "nothing to point at before there is an error");
  assert.equal(document.activeElement, code, "focus is in the field");
});

test("an empty access code is not sent", async (t) => {
  const { container, act, requests } = await openLoginPage(t, () => status("access_code"));
  await act(async () => button(container, "Fortsätt")!.click());
  assert.deepEqual(requests, ["GET /api/auth/status"]);
});

test("a refused access code is said once, as an alert, the field is marked and has focus again to type it", async (t) => {
  const { container, act, requests, router } = await openLoginPage(t, (url) =>
    url === "/api/auth/login" ? json({ detail: "Felaktig åtkomstkod" }, 401) : status("access_code"),
  );
  const code = field(container, "Åtkomstkod")!;
  await act(async () => type(code, "fel-kod"));
  await act(async () => button(container, "Fortsätt")!.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.deepEqual(requests, ["GET /api/auth/status", "POST /api/auth/login"]);
  assert.deepEqual(alerts(document.body).filter((text) => text.includes("Felaktig åtkomstkod.")), ["Felaktig åtkomstkod."], "said once");
  assert.equal(code.getAttribute("aria-invalid"), "true", "the field in error is identified");
  // The field points at the message: the one alert, not a second text that would be announced as well.
  const message = document.getElementById(code.getAttribute("aria-errormessage") ?? "-");
  assert.ok(message, "the field names its error message");
  assert.equal(message.getAttribute("role"), "alert");
  assert.equal(message.textContent, "Felaktig åtkomstkod.");
  assert.equal(code.disabled, false);
  assert.equal(document.activeElement, code, "focus is back in the field");
  assert.equal(router.state.location.pathname, "/", "it stays where it is");
});

test("any other failure to sign in with the code is said in one sentence and the field is open again", async (t) => {
  for (const answer of [() => json({ detail: "boom" }, 500), () => Promise.reject(new TypeError("Failed to fetch"))]) {
    const { container, act, unmount } = await openLoginPage(t, (url) => (url === "/api/auth/login" ? answer() : status("access_code")));
    const code = field(container, "Åtkomstkod")!;
    await act(async () => type(code, "en-kod-som-inte-kan-kontrolleras"));
    await act(async () => button(container, "Fortsätt")!.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    assert.deepEqual(alerts(document.body).filter((text) => text.includes("Inloggningen")), ["Inloggningen kunde inte slutföras. Försök igen."]);
    assert.equal(document.activeElement, code);
    await unmount();
  }
});

test("a correct access code goes on to the flow list", async (t) => {
  const { container, act, router } = await openLoginPage(t, (url) => (url === "/api/auth/login" ? json({ ok: true }) : status("access_code")));
  await act(async () => type(field(container, "Åtkomstkod")!, "en-riktig-kod-1234"));
  await act(async () => button(container, "Fortsätt")!.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(router.state.location.pathname, "/flows");
  assert.equal(router.state.historyAction, "REPLACE", "in place of the sign-in page: Back does not return to it");
});

test("someone already signed in goes straight on to the flow list", async (t) => {
  const { router } = await openLoginPage(t, () => json({ authenticated: true, auth_mode: "eneo_sso", user: { id: "u", email: "a@b.se", username: "A" } }));
  assert.equal(router.state.location.pathname, "/flows");
  assert.equal(router.state.historyAction, "REPLACE");
});

test("Eneo's refusal of the sign-in is said, and the address is cleaned of it", async (t) => {
  window.history.replaceState(null, "", "/?auth_error=1");
  const { container, router } = await openLoginPage(t, () => status("access_code"));
  assert.deepEqual(alerts(document.body).filter((text) => text.includes("Inloggningen")), ["Inloggningen kunde inte slutföras. Försök igen."]);
  assert.equal(router.state.location.search, "", "the router has the address without it");
  assert.equal(router.state.historyAction, "REPLACE", "in place: Back does not return to the refusal");
  assert.ok(field(container, "Åtkomstkod"), "the way in is still there");
  assert.equal(document.getElementById(field(container, "Åtkomstkod")!.getAttribute("aria-errormessage") ?? "-")?.getAttribute("role"), "alert");
});

test("a module that cannot be reached is said, with a way to try again and nothing to fill in", async (t) => {
  const { container } = await openLoginPage(t, () => Promise.reject(new TypeError("Failed to fetch")));
  assert.deepEqual(alerts(document.body).filter((text) => text.includes("Kunde inte")), ["Kunde inte kontakta modulen. Försök igen."]);
  assert.ok(button(container, "Försök igen"));
  assert.equal(container.querySelectorAll("input").length, 0);
  assert.equal(container.querySelectorAll('main, [role="main"]').length, 1, "one main region");
});
