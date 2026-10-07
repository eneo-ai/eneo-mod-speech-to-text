/**
 * Routers for component tests. `withRouter` is a memory router (a data router, as the app's is, so `useBlocker` works)
 * with the element at `path`; the router is returned beside the tree, so a test reads `router.state.location` and
 * drives `router.navigate(...)` where the page cannot, and `visited` lists where it went. Any other address is an empty route, the page left.
 * `inStaticRouter` is for markup that is rendered once, as a string: its links resolve and nothing navigates.
 */

import { createElement, type ReactElement } from "react";
import { createMemoryRouter, RouterProvider, StaticRouter, type InitialEntry } from "react-router";

export function withRouter(element: ReactElement, { path = "/", entries = [path] }: { path?: string; entries?: InitialEntry[] } = {}) {
  const router = createMemoryRouter([{ path, element }, { path: "*", element: null }], { initialEntries: entries });
  // Every address the router moved to, in order, for a test that asserts the page went nowhere (`[]`) or somewhere.
  const visited: string[] = [];
  let last = router.state.location;
  router.subscribe((state) => {
    if (state.location === last) return;
    last = state.location;
    visited.push(`${state.location.pathname}${state.location.search}`);
  });
  return { router, visited, tree: createElement(RouterProvider, { router }) };
}

export const inStaticRouter = (element: ReactElement, location = "/") => createElement(StaticRouter, { location }, element);
