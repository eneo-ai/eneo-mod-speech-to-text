import assert from "node:assert/strict";
import test, { afterEach, type TestContext } from "node:test";

import { cleanup, installDom, mount } from "./test-dom";
import { withRouter } from "./test-router";

installDom();
afterEach(async () => {
  await cleanup();
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

type User = import("./api").AuthenticatedUser;

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const ANNA: User = { id: "user-1", email: "anna@example.se", username: "Anna Berg" };

/** The account menu as a page gives it: the router, the signed-in user, the colour mode, and the page's leave question. */
async function openAccountMenu(
  t: TestContext,
  options: { user?: User; leaveFirst?: (goOn: () => void) => void; logout?: () => Promise<Response> } = {},
) {
  const { createElement } = await import("react");
  const { ModuleProviders } = await import("@/kit/ModuleProviders");
  const { AuthenticatedUserContext } = await import("../components/AuthGate");
  const { LeaveContext } = await import("../components/flow/useLeaveQuestion");
  const { AccountMenu } = await import("../components/AccountMenu");
  const requests: string[] = [];
  const browserFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${url}`);
    return options.logout ? options.logout() : new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = browserFetch;
  });
  const leave = { leaveFirst: options.leaveFirst ?? ((goOn: () => void) => goOn()) };
  // The page is the flow list; signing out leaves it for the sign-in page ("/").
  const { router, tree } = withRouter(
    createElement(
      ModuleProviders,
      null,
      createElement(
        AuthenticatedUserContext.Provider,
        { value: options.user ?? ANNA },
        createElement(LeaveContext.Provider, { value: leave }, createElement("p", { id: "page" }, "Sidan"), createElement(AccountMenu)),
      ),
    ),
    { path: "/flows" },
  );
  const view = await mount(tree);
  const trigger = () => [...view.container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label")?.startsWith("Öppna konto"))!;
  const menu = () => document.body.querySelector<HTMLElement>('[role="menu"]');
  /** Opens it as a pointer does: the press, then the click. */
  const open = () =>
    view.act(async () => {
      trigger().dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
      trigger().click();
      await settle();
    });
  const item = (name: string) =>
    [...document.body.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((element) => element.textContent?.trim() === name || element.textContent?.includes(name))!;
  return { ...view, router, requests, trigger, menu, open, item };
}

test("the trigger is named by who is signed in, and opens a menu", async (t) => {
  const { trigger, menu, open } = await openAccountMenu(t);
  assert.equal(trigger().getAttribute("aria-label"), "Öppna konto för Anna Berg");
  assert.equal(trigger().getAttribute("aria-haspopup"), "menu");
  assert.ok(!menu() || !menu()!.checkVisibility?.(), "closed to begin with");
  await open();
  assert.ok(menu(), "open");
  assert.equal(trigger().getAttribute("aria-expanded"), "true");
});

test("the menu is not modal: the page behind it stays in the accessibility tree", async (t) => {
  const { open } = await openAccountMenu(t);
  await open();
  const page = document.getElementById("page")!;
  for (let element: HTMLElement | null = page; element && element !== document.documentElement; element = element.parentElement) {
    assert.equal(element.getAttribute("aria-hidden"), null, `${element.tagName} is not hidden`);
    assert.equal(element.hasAttribute("inert"), false, `${element.tagName} is not inert`);
  }
});

test("the name is shown at the top, and the e-mail when it says more; neither is something to choose", async (t) => {
  const named = await openAccountMenu(t);
  await named.open();
  assert.match(named.menu()!.textContent ?? "", /Anna Berg/);
  assert.match(named.menu()!.textContent ?? "", /anna@example\.se/);
  const choices = [...named.menu()!.querySelectorAll('[role^="menuitem"]')].map((element) => element.textContent);
  assert.deepEqual(choices.filter((text) => /Anna|example/.test(text ?? "")), [], "not menu items");
  await named.unmount();

  // Without a name the e-mail is the name, and is not said twice.
  const bare = await openAccountMenu(t, { user: { id: "user-2", email: "erik@example.se", username: "" } });
  await bare.open();
  assert.equal(bare.trigger().getAttribute("aria-label"), "Öppna konto för erik@example.se");
  assert.equal((bare.menu()!.textContent ?? "").split("erik@example.se").length - 1, 1, "said once");
  await bare.unmount();
});

test("Ljust, Mörkt and System are one group named Tema, with the stored choice marked", async (t) => {
  window.localStorage.setItem("theme", "dark");
  const { menu, open } = await openAccountMenu(t);
  await open();
  const group = menu()!.querySelector<HTMLElement>('[role="group"]')!;
  assert.equal(group.getAttribute("aria-label"), "Tema");
  const radios = [...group.querySelectorAll('[role="menuitemradio"]')];
  assert.deepEqual(radios.map((radio) => radio.textContent?.trim()), ["Ljust", "Mörkt", "System"]);
  assert.deepEqual(radios.map((radio) => radio.getAttribute("aria-checked")), ["false", "true", "false"]);
});

test("choosing a colour mode sets the page's mode: data-theme on <html> for light and dark, none for the system's, kept for the next visit", async (t) => {
  const { open, item, act } = await openAccountMenu(t);
  const dataTheme = () => document.documentElement.getAttribute("data-theme");
  const choose = async (name: string) => {
    await open();
    await act(async () => {
      item(name).click();
      await settle();
    });
  };
  await choose("Mörkt");
  assert.equal(dataTheme(), "dark");
  assert.equal(window.localStorage.getItem("theme"), "dark");
  await choose("Ljust");
  assert.equal(dataTheme(), "light");
  assert.equal(window.localStorage.getItem("theme"), "light");
  await choose("System");
  assert.equal(dataTheme(), null, "the system's own preference paints it");
  assert.equal(window.localStorage.getItem("theme"), "system");
});

test("Logga ut asks the page's leave question first, and does nothing until the answer is to go on", async (t) => {
  const asked: (() => void)[] = [];
  const { open, item, act, requests, router } = await openAccountMenu(t, { leaveFirst: (goOn) => asked.push(goOn) });
  await open();
  await act(async () => {
    item("Logga ut").click();
    await settle();
  });
  assert.equal(asked.length, 1, "asked once");
  assert.deepEqual(requests, [], "not signed out yet");
  assert.equal(router.state.location.pathname, "/flows");
  await act(async () => {
    asked[0]();
    await settle();
  });
  assert.deepEqual(requests, ["POST /api/auth/logout"]);
  assert.equal(router.state.location.pathname, "/", "gone to the sign-in page");
  assert.equal(router.state.historyAction, "REPLACE", "in place of the page, not on top of it");
});

test("while signing out it says so, cannot be pressed again, and the page is left however the answer came", async (t) => {
  for (const answer of [() => Promise.resolve(new Response("{}", { status: 200 })), () => Promise.reject(new TypeError("Failed to fetch")), () => Promise.resolve(new Response("{}", { status: 500 }))]) {
    let finish: () => void = () => {};
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const { open, item, act, requests, router, unmount } = await openAccountMenu(t, { logout: () => gate.then(answer) });
    await open();
    await act(async () => {
      item("Logga ut").click();
      await settle();
    });
    const running = item("Loggar ut…");
    assert.ok(running, "says so on the item, which the menu stays open to show");
    assert.ok(running.getAttribute("aria-disabled") === "true" || running.hasAttribute("disabled"), "cannot be chosen again");
    await act(async () => {
      running.click();
      await settle();
    });
    assert.deepEqual(requests, ["POST /api/auth/logout"], "one request");
    assert.equal(router.state.location.pathname, "/flows", "still here while it runs");
    await act(async () => {
      finish();
      await settle();
    });
    assert.equal(router.state.location.pathname, "/", "and gone to the sign-in page when it ended");
    assert.equal(router.state.historyAction, "REPLACE");
    await unmount();
  }
});
