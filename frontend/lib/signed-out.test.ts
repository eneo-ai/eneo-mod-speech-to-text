import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { button, cleanup, installDom, mount } from "./test-dom";

installDom();
afterEach(cleanup);

test("signed out: the page stays mounted with all it holds, hidden and out of reach, until the new login", async () => {
  const { createElement, useState } = await import("react");
  const { SignedOutCover } = await import("../components/AuthGate");
  function Counter() {
    const [count, setCount] = useState(0);
    return createElement("button", { type: "button", onClick: () => setCount(count + 1) }, `Räknat ${count}`);
  }
  let setSignedOut: (on: boolean) => void = () => {};
  function Page() {
    const [signedOut, set] = useState(false);
    setSignedOut = set;
    return createElement(SignedOutCover, { signedOut, children: createElement(Counter) });
  }
  const { container, act } = await mount(createElement(Page));
  await act(async () => button(container, "Räknat 0")!.click());
  const cover = () => container.firstElementChild as HTMLElement;
  assert.equal(cover().hasAttribute("inert"), false);

  await act(async () => setSignedOut(true));
  assert.equal(cover().hasAttribute("inert"), true, "out of reach");
  assert.match(cover().className, /\binvisible\b/, "and not shown");
  assert.ok(button(container, "Räknat 1"), "still there, as it was");

  await act(async () => setSignedOut(false));
  assert.equal(cover().hasAttribute("inert"), false);
  assert.doesNotMatch(cover().className, /\binvisible\b/);
  assert.ok(button(container, "Räknat 1"));
});

test("signed out: the dialog asks for a new login, says the page and a recording go on, and cannot be closed without one", async () => {
  const { createElement } = await import("react");
  const { SessionEndWarning } = await import("../components/SessionEndWarning");
  const { act } = await mount(
    createElement(SessionEndWarning, { endsAt: Date.now() + 3_600_000, mode: "eneo_sso", signedOut: true, onRenewed: () => {} }),
  );
  const dialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]');
  assert.match(dialog()?.textContent ?? "", /Du behöver logga in igen/);
  assert.match(dialog()?.textContent ?? "", /inspelning fortsätter/);
  assert.ok(button(dialog()!, "Logga in igen"));
  assert.equal(button(dialog()!, "Stäng"), null, "no way past it but the new login");

  await act(async () => {
    dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.ok(dialog(), "Escape keeps it open");
});

test("someone signing in here keeps only their own drafts: another person's typed details and review edits go", async (t) => {
  const { createElement } = await import("react");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { AuthGate } = await import("../components/AuthGate");
  const { browserDrafts, readDraft, writeDraft } = await import("./drafts");
  const browserFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ authenticated: true, auth_mode: "eneo_sso", user: { id: "user-1", email: "anna@example.se" }, session_ends_in: 8 * 3600 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = browserFetch;
    window.sessionStorage.clear();
  });
  writeDraft(browserDrafts(), "user-1", "flow:flow-1", { motesnamn: "Byggnadsnämnden" });
  writeDraft(browserDrafts(), "user-2", "flow:flow-1", { motesnamn: "Socialnämnden" });
  const go = () => undefined;
  const router = { push: go, replace: go, prefetch: go, back: go, forward: go, refresh: go } as unknown as import("next/dist/shared/lib/app-router-context.shared-runtime").AppRouterInstance;
  const { container, act } = await mount(createElement(AppRouterContext.Provider, { value: router }, createElement(AuthGate, { children: "Sidan" })));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.match(container.textContent ?? "", /Sidan/);
  assert.deepEqual(readDraft(browserDrafts(), "user-1", "flow:flow-1"), { motesnamn: "Byggnadsnämnden" });
  assert.equal(readDraft(browserDrafts(), "user-2", "flow:flow-1"), null);
});
