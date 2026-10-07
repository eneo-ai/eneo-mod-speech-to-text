import assert from "node:assert/strict";
import test, { afterEach, type TestContext } from "node:test";

import { cleanup, installDom, mount } from "./test-dom";

installDom();
afterEach(cleanup);

/** The route table's frame (routes.tsx) around one lazy page, with the backend's branding answer stubbed. */
async function open(t: TestContext, load: () => Promise<{ Component: () => import("react").ReactElement }>) {
  const { createElement } = await import("react");
  const { createMemoryRouter, RouterProvider } = await import("react-router");
  const { Root, RootHydrateFallback, RouteError } = await import("@/routes/Root");
  const browserFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ organization: null }), { headers: { "content-type": "application/json" } })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = browserFetch;
  });
  const logged = t.mock.method(console, "error", () => undefined);
  const router = createMemoryRouter(
    [{ Component: Root, HydrateFallback: RootHydrateFallback, children: [{ ErrorBoundary: RouteError, children: [{ path: "/", lazy: load }] }] }],
    { initialEntries: ["/"] },
  );
  const view = await mount(createElement(RouterProvider, { router }));
  return { ...view, router, logged };
}

const headings = (within: ParentNode) => [...within.querySelectorAll("h1")].map((heading) => heading.textContent);

test("while the first page's code is on its way the frame shows the loading shell, not a blank page", async (t) => {
  const { createElement } = await import("react");
  let arrive!: () => void;
  const { container, act } = await open(t, () => new Promise((resolve) => (arrive = () => resolve({ Component: () => createElement("h1", null, "Sidan") }))));
  assert.deepEqual(headings(container), ["Tal till text"], "the shell's heading");
  assert.ok(container.querySelector('[role="status"], [aria-label="Laddar"]'), "a spinner that says it is loading");
  assert.ok(container.querySelector("nav[aria-label='Tal till text']"), "the bar");
  await act(async () => arrive());
  assert.deepEqual(headings(container), ["Sidan"], "then the page");
});

test("a page whose code cannot be loaded is replaced by a message inside the frame, with a reload to press and a way home", async (t) => {
  const { container, logged } = await open(t, async () => {
    throw new TypeError("Failed to fetch dynamically imported module");
  });
  assert.deepEqual(headings(container), ["Sidan kunde inte visas."]);
  assert.match(container.textContent ?? "", /Ladda om sidan\./);
  const reload = [...container.querySelectorAll("button")].find((button) => button.textContent === "Ladda om sidan");
  assert.ok(reload, "a button that reloads, when a person presses it");
  const home = [...container.querySelectorAll("a")].find((link) => link.textContent === "Till startsidan");
  assert.equal(home?.getAttribute("href"), "/", "a link to the start page");
  assert.ok(container.querySelector("nav[aria-label='Tal till text']"), "the bar is still there");
  assert.equal(container.querySelectorAll('main, [role="main"]').length, 1, "one main region");
  assert.ok(
    logged.mock.calls.some((call) => String(call.arguments.join(" ")).includes("A page could not be shown")),
    "the error is logged for whoever looks",
  );
});

test("a page that throws is replaced the same way, at the address the page had", async (t) => {
  const { container, router } = await open(t, async () => ({
    Component: () => {
      throw new Error("the page broke");
    },
  }));
  assert.deepEqual(headings(container), ["Sidan kunde inte visas."]);
  assert.equal(router.state.location.pathname, "/");
});
