/**
 * A router for component tests: a memory router (a data router, as the app's is, so `useBlocker` works) with the element
 * at `path`. The router is returned beside the tree, so a test reads `router.state.location` and drives
 * `router.navigate(...)` where the page cannot. Any other address is an empty route, the page left.
 */

import type { ReactElement } from "react";

export async function withRouter(element: ReactElement, { path = "/", entries = [path] }: { path?: string; entries?: string[] } = {}) {
  const { createElement } = await import("react");
  const { createMemoryRouter, RouterProvider } = await import("react-router");
  const router = createMemoryRouter([{ path, element }, { path: "*", element: null }], { initialEntries: entries });
  return { router, tree: createElement(RouterProvider, { router }) };
}
