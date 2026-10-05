import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { button, cleanup, installDom, mount } from "./test-dom";
import { withRouter } from "./test-router";

installDom();
afterEach(cleanup);

/** Under the page's providers, so the design system speaks Swedish: its own words (the dialog's "Stäng") come from there. */
async function inProviders(element: import("react").ReactElement) {
  const { createElement } = await import("react");
  const { ModuleProviders } = await import("../kit/ModuleProviders");
  return createElement(ModuleProviders, { children: element });
}

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
  assert.match(cover().className, /pageSignedOut/, "and not shown (its class hides it)");
  assert.ok(button(container, "Räknat 1"), "still there, as it was");

  await act(async () => setSignedOut(false));
  assert.equal(cover().hasAttribute("inert"), false);
  assert.doesNotMatch(cover().className, /pageSignedOut/);
  assert.ok(button(container, "Räknat 1"));
});

test("signed out: the dialog asks for a new login, says the page and a recording go on, and cannot be closed without one", async () => {
  const { createElement } = await import("react");
  const { SessionEndWarning } = await import("../components/SessionEndWarning");
  const { act } = await mount(
    await inProviders(createElement(SessionEndWarning, { endsAt: Date.now() + 3_600_000, signedOut: true })),
  );
  const dialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]');
  assert.equal(dialog()?.tagName, "DIALOG", "a native dialog: the browser keeps it above whatever the page has open");
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
  const { AuthGate } = await import("../components/AuthGate");
  const { browserDrafts, readDraft, writeDraft } = await import("./drafts");
  const { isRecord } = await import("./is-record");
  const browserFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ authenticated: true, user: { id: "user-1", email: "anna@example.se" }, session_ends_in: 8 * 3600 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = browserFetch;
    window.sessionStorage.clear();
  });
  writeDraft(browserDrafts(), "user-1", "flow:flow-1", { motesnamn: "Byggnadsnämnden" });
  writeDraft(browserDrafts(), "user-2", "flow:flow-1", { motesnamn: "Socialnämnden" });
  const { container, act } = await mount(withRouter(createElement(AuthGate, { children: "Sidan" })).tree);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.match(container.textContent ?? "", /Sidan/);
  assert.deepEqual(readDraft(browserDrafts(), "user-1", "flow:flow-1", isRecord), { motesnamn: "Byggnadsnämnden" });
  assert.equal(readDraft(browserDrafts(), "user-2", "flow:flow-1", isRecord), null);
});

test("signed out, Logga in igen starts a new login; before the end, a renewal bound to the user signed in now", async (t) => {
  const { createElement } = await import("react");
  const { SessionEndWarning } = await import("../components/SessionEndWarning");
  const opened: string[] = [];
  t.mock.method(window, "open", (url: string) => {
    opened.push(url);
    return {} as Window;
  });
  const endsAt = Date.now() + 60_000; // the warning is open: less than five minutes left
  const warning = await mount(createElement(SessionEndWarning, { endsAt }));
  const dialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]')!;
  // It opens on a timer, which a busy machine fires late.
  await warning.act(async () => {
    for (let waited = 0; !document.body.querySelector('[role="alertdialog"]') && waited < 2_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await warning.act(async () => button(dialog(), "Fortsätt arbeta")!.click());
  await warning.unmount();
  const ended = await mount(createElement(SessionEndWarning, { endsAt, signedOut: true }));
  await ended.act(async () => button(dialog(), "Logga in igen")!.click());
  // The backend refuses a renewal once there is no login left to bind it to.
  assert.deepEqual(opened, ["/api/auth/login?renew=1&next=%2Finloggad", "/api/auth/login?next=%2Finloggad"]);
});

test("someone else signed in: the dialog says who, and whom to sign in as, and stays", async () => {
  const { createElement } = await import("react");
  const { SessionEndWarning } = await import("../components/SessionEndWarning");
  await mount(
    await inProviders(
      createElement(SessionEndWarning, {
        endsAt: Date.now() + 3_600_000,
        signedOut: true,
        owner: { id: "user-1", email: "anna@example.se", username: "Anna Berg" },
        otherUser: { id: "user-2", email: "erik@example.se", username: "Erik Lund" },
      }),
    ),
  );
  const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')!;
  assert.match(dialog.textContent ?? "", /Du är inloggad som Erik Lund\. Logga in som Anna Berg för att fortsätta\./);
  assert.ok(button(dialog, "Logga in igen"));
  assert.equal(button(dialog, "Stäng"), null);
});

test("signed out, a recording can still be paused and stopped from the sign-in dialog, without logging in", async () => {
  const { createElement } = await import("react");
  const { SessionEndWarning } = await import("../components/SessionEndWarning");
  const { SignedOutSlot } = await import("../components/AuthGate");
  const { SignedOutControls } = await import("../components/flow/Recorder");
  const pressed: string[] = [];
  let slot: HTMLElement | null = null;
  const warning = await mount(
    createElement(SessionEndWarning, {
      endsAt: Date.now() + 3_600_000,
      signedOut: true,
      controlsRef: (element: HTMLElement | null) => (slot = element),
    }),
  );
  const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')!;
  assert.ok(slot && dialog.contains(slot), "the dialog keeps a place for the page's recording controls");
  const recorder = (phase: "recording" | "paused" | "ready") =>
    createElement(
      SignedOutSlot.Provider,
      { value: slot },
      createElement(SignedOutControls, { phase, onPause: () => pressed.push("pausa"), onStop: () => pressed.push("stoppa") }),
    );
  const page = await mount(recorder("recording"));
  await page.act(async () => button(dialog, "Pausa")!.click());
  await page.act(async () => button(dialog, "Stoppa")!.click());
  assert.deepEqual(pressed, ["pausa", "stoppa"]);
  await page.unmount();
  const ready = await mount(recorder("ready"));
  assert.equal(button(dialog, "Stoppa"), null, "nothing to stop once the recording is done");
  await ready.unmount();
  await warning.unmount();
});

test("signed out, a dialog open on the page is hidden and out of reach with it, and keeps what was typed in it", async () => {
  const { createElement, useState } = await import("react");
  const { SignedOutCover } = await import("../components/AuthGate");
  const { Dialog } = await import("@astryxdesign/core/Dialog");
  const { type } = await import("./test-dom");
  let setSignedOut: (on: boolean) => void = () => {};
  function Page() {
    const [signedOut, set] = useState(false);
    setSignedOut = set;
    return createElement(SignedOutCover, {
      signedOut,
      children: createElement(Dialog, {
        isOpen: true,
        onOpenChange() {},
        "aria-label": "Namnge talarna",
        children: createElement("input", { "aria-label": "Vem är Talare 1?" }),
      }),
    });
  }
  const { act } = await mount(createElement(Page));
  const field = document.body.querySelector<HTMLInputElement>('input[aria-label="Vem är Talare 1?"]')!;
  await act(async () => type(field, "Anna Berg"));

  await act(async () => setSignedOut(true));
  // A native dialog is an element of its own (it carries no role attribute).
  const dialog = document.body.querySelector<HTMLElement>("dialog[open]")!;
  // A structural check of the cover only: the design system's dialog sits in the page's own subtree. In a browser a
  // native dialog escapes an inert ancestor, which jsdom cannot show: so a page's dialog closes while signed out
  // (useSignedOut), and that it is neither visible, reachable nor in the accessibility tree is proved in
  // tests/e2e/session-cover.spec.ts and, for the PDF preview, in result-document.test.ts.
  assert.ok(dialog.closest("[inert]"), "inside the inert cover");
  assert.match(dialog.closest("[inert]")!.className, /pageSignedOut/, "and not shown");
  assert.equal(document.body.querySelector('input[aria-label="Vem är Talare 1?"]'), field, "the same field, still mounted");
  assert.equal(field.value, "Anna Berg");
});

test("after the new login the focus is back where it was, or on the page's heading when that is gone", async (t) => {
  const { createElement, useState } = await import("react");
  const { AuthGate } = await import("../components/AuthGate");
  const { loginState } = await import("./login-state");
  const anna = { id: "user-1", email: "anna@example.se", username: "Anna Berg" };
  const browserFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ authenticated: true, user: anna, session_ends_in: 8 * 3600 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = browserFetch;
  });
  let setShown: (shown: boolean) => void = () => {};
  function Recorder() {
    const [shown, set] = useState(true);
    setShown = set;
    return createElement(
      "main",
      null,
      createElement("h2", { "data-phase-heading": "", tabIndex: -1 }, "Spelar in"),
      shown && createElement("button", { type: "button" }, "Pausa"),
    );
  }
  const { container, act } = await mount(withRouter(createElement(AuthGate, { children: createElement(Recorder) })).tree);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const signOutAndBack = async (whileOut = () => {}) => {
    await act(async () => loginState.observe({ authenticated: false, user: null }));
    // As Chromium does once the page under the focus turns inert.
    await act(async () => (document.activeElement as HTMLElement | null)?.blur());
    await act(async () => whileOut());
    await act(async () => loginState.observe({ authenticated: true, user: anna, session_ends_in: 8 * 3600 }));
    // The sign-in dialog hands the focus back once it has closed.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  };

  const pausa = button(container, "Pausa")!;
  pausa.focus();
  await signOutAndBack();
  assert.ok(document.activeElement === pausa, "back on Pausa");

  pausa.focus();
  await signOutAndBack(() => setShown(false));
  const heading = container.querySelector("[data-phase-heading]");
  assert.ok(document.activeElement === heading, "Pausa is gone: the page's heading");

  // The focus was not on the page (the warning's button): the page's heading, never that.
  const outside = document.createElement("button");
  document.body.append(outside);
  t.after(() => outside.remove());
  outside.focus();
  await signOutAndBack();
  assert.ok(document.activeElement === heading);
});

test("the 5-minute warning open when the login ends: after the new login the focus goes where it was before the warning, else the heading", async (t) => {
  const { createElement, useState } = await import("react");
  const { AuthGate } = await import("../components/AuthGate");
  const { loginState } = await import("./login-state");
  const anna = { id: "user-1", email: "anna@example.se", username: "Anna Berg" };
  const browserFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = browserFetch;
  });
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  for (const keep of [false, true]) {
    // A second past the warning's five minutes: the warning opens a second after the page.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ authenticated: true, user: anna, session_ends_in: 5 * 60 + 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    let setShown: (shown: boolean) => void = () => {};
    function Recorder() {
      const [shown, set] = useState(true);
      setShown = set;
      return createElement(
        "main",
        null,
        createElement("h2", { "data-phase-heading": "", tabIndex: -1 }, "Spelar in"),
        shown && createElement("button", { type: "button" }, "Pausa"),
      );
    }
    const view = await mount(withRouter(createElement(AuthGate, { children: createElement(Recorder) })).tree);
    await view.act(async () => wait(20));
    const pausa = button(view.container, "Pausa")!;
    pausa.focus();
    await view.act(async () => wait(1_100));
    assert.ok(document.body.querySelector('[role="alertdialog"][open]'), "the warning is open");
    await view.act(async () => loginState.observe({ authenticated: false, user: null }));
    if (!keep) await view.act(async () => setShown(false));
    // The new login: the page reads the status again, with its new end.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ authenticated: true, user: anna, session_ends_in: 8 * 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    await view.act(async () => {
      document.dispatchEvent(new window.Event("visibilitychange"));
      await wait(20);
    });
    assert.ok(!document.body.querySelector('[role="alertdialog"][open]'), "closed");
    const heading = view.container.querySelector("[data-phase-heading]");
    if (keep) assert.ok(document.activeElement === pausa, "back on Pausa, where it was before the warning");
    else assert.ok(document.activeElement === heading, "Pausa is gone: the page's heading, not the body");
    await view.unmount();
  }
});

test("when the login ends the focus moves into the sign-in dialog, onto its heading, so a screen reader says it", async () => {
  const { createElement, useState } = await import("react");
  const { SessionEndWarning } = await import("../components/SessionEndWarning");
  let setSignedOut: (on: boolean) => void = () => {};
  function Page() {
    const [signedOut, set] = useState(false);
    setSignedOut = set;
    return createElement(
      "div",
      null,
      createElement("button", { type: "button" }, "Pausa på sidan"),
      createElement(SessionEndWarning, { endsAt: Date.now() + 3_600_000, signedOut }),
    );
  }
  const { container, act } = await mount(createElement(Page));
  button(container, "Pausa på sidan")!.focus();
  await act(async () => setSignedOut(true));
  const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')!;
  const heading = [...dialog.querySelectorAll("h2")].find((h) => h.textContent === "Du behöver logga in igen");
  assert.ok(heading && document.activeElement === heading, "on the dialog's heading");
});

test("before the end the warning can be closed, with Stäng or Escape; the page keeps all it holds", async () => {
  const { createElement } = await import("react");
  const { SessionEndWarning } = await import("../components/SessionEndWarning");
  // In the tree while it is open only.
  const dialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]');
  // Less than five minutes left: it opens on a timer, which a busy machine fires late.
  const opens = async () => {
    for (let waited = 0; !dialog() && waited < 2_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const endsAt = Date.now() + 60_000;
  const first = await mount(await inProviders(createElement(SessionEndWarning, { endsAt })));
  await first.act(opens);
  assert.ok(dialog()!.hasAttribute("open"));
  assert.match(dialog()!.textContent ?? "", /Du loggas snart ut/);
  await first.act(async () => button(dialog()!, "Stäng")!.click());
  assert.ok(!dialog(), "Stäng closes it");
  await first.unmount();

  const second = await mount(await inProviders(createElement(SessionEndWarning, { endsAt })));
  await second.act(opens);
  assert.ok(dialog());
  await second.act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.ok(!dialog(), "Escape closes it");
});

test("a login that ends in more than 24.8 days sets no timer longer than a platform keeps: it would fire at once", async (t) => {
  const { createElement } = await import("react");
  const { SessionEndWarning } = await import("../components/SessionEndWarning");
  const MOST = 2 ** 31 - 1;
  const realSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  // The delay is recorded as asked for and kept within what the platform holds, so that the test itself waits as long.
  t.mock.method(globalThis, "setTimeout", (callback: () => void, delay?: number) => {
    delays.push(Number(delay));
    return realSetTimeout(callback, Math.min(Number(delay ?? 0), MOST));
  });
  const month = 30 * 24 * 3_600_000;
  const { unmount } = await mount(createElement(SessionEndWarning, { endsAt: Date.now() + month }));
  assert.ok(Math.max(...delays) <= MOST, `the longest delay asked for: ${Math.max(...delays)}`);
  await unmount();
});
