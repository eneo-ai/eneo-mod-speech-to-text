import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { cleanup, installDom, mount } from "./test-dom";

installDom();
afterEach(async () => {
  await cleanup();
  document.title = "";
});

/**
 * A frame with RouteEffects and three pages that name themselves in their route. RouteEffects sits after the page, the
 * worst place for it: a passive effect there would run after the page's own and take its title.
 */
async function open(entry: string, pageTitle?: string) {
  const { createElement } = await import("react");
  const { createMemoryRouter, Outlet, RouterProvider } = await import("react-router");
  const { RouteEffects } = await import("../routes/RouteEffects");
  const { useDocumentTitle } = await import("../components/flow/recording-hooks");
  function Flow() {
    // A page that names itself once it has what it needs, as the flow page does.
    useDocumentTitle(pageTitle ?? "Nämndmöte · Tal till text");
    return createElement("p", null, "Flödet");
  }
  const router = createMemoryRouter(
    [
      {
        element: createElement("div", null, createElement(Outlet), createElement(RouteEffects)),
        children: [
          { index: true, handle: { title: "Logga in · Tal till text" }, element: createElement("p", null, "Start") },
          { path: "flows", handle: { title: "Välj ett flöde · Tal till text" }, element: createElement("p", null, "Listan") },
          { path: "flows/:id", handle: { title: "Tal till text" }, element: createElement(Flow) },
          { path: "free", element: createElement("p", null, "Utan titel") },
        ],
      },
    ],
    { initialEntries: [entry] },
  );
  const view = await mount(createElement(RouterProvider, { router }));
  return { ...view, router };
}

test("a page is titled by its route from the first frame", async () => {
  await open("/");
  assert.equal(document.title, "Logga in · Tal till text");
  await cleanup();
  await open("/flows");
  assert.equal(document.title, "Välj ett flöde · Tal till text");
});

test("a navigation retitles the page at once, and a page that names itself later has the last word", async () => {
  const { router, act } = await open("/flows");
  await act(async () => router.navigate("/flows/abc"));
  assert.equal(document.title, "Nämndmöte · Tal till text", "the flow page's own title, set after the route's");
});

test("Back to the list is titled the list, not the flow", async () => {
  const { router, act } = await open("/flows");
  await act(async () => router.navigate("/flows/abc"));
  await act(async () => router.navigate(-1));
  assert.equal(document.title, "Välj ett flöde · Tal till text");
});

test("a change of the address that keeps the path does not touch the title the page set", async () => {
  const { router, act } = await open("/flows/abc");
  await act(async () => router.navigate({ search: "?run=r1" }, { replace: true }));
  assert.equal(document.title, "Nämndmöte · Tal till text");
});

test("a route with no title leaves the title as it was", async () => {
  const { router, act } = await open("/flows");
  await act(async () => router.navigate("/free"));
  assert.equal(document.title, "Välj ett flöde · Tal till text");
});
