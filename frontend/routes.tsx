import type { ComponentType } from "react";
import { createBrowserRouter, type RouteObject } from "react-router";
import { NotFound, Root, RootHydrateFallback, RouteError } from "@/routes/Root";
import type { RouteHandle } from "@/routes/RouteEffects";
import { lazyLoader, type Loader } from "@/lib/lazy-component";
import { flowPageCode } from "@/routes/flow-page-code";
import { documentTitle } from "@/lib/product";

/**
 * One page. Its code is fetched when the route is first entered, so a person on the sign-in page does not download the
 * recording or the review (`tests/prod/weight.spec.ts` holds one budget per page). The flow page's is also fetched while
 * the flow list is read (routes/FlowsPage.tsx), through the same loader, so a flow opens at once, also offline. A page
 * entered while the device has no network waits for it (lazyLoader): an import that fails offline would fail for as long
 * as the tab is open.
 */
function page(where: { path: string } | { index: true }, title: string, code: Loader<ComponentType>): RouteObject {
  return { ...where, handle: { title } satisfies RouteHandle, lazy: async () => ({ Component: await code.load() }) };
}

/** A page module's default export, fetched once. */
const pageCode = (load: () => Promise<{ default: ComponentType }>) => lazyLoader(() => load().then((module) => module.default));

// Spelled out where they are used, so the bundler knows the conditions at build time and drops the imports from a
// default build: `vite build --mode check` compiles the two fixtures that the real-backend gate needs, the dev server
// all three.
const fixtures: RouteObject[] = [
  ...(import.meta.env.DEV || import.meta.env.MODE === "check"
    ? [
        page({ path: "dev/foundation" }, documentTitle(), lazyLoader(async () => (await import("./routes/dev/FoundationCheck")).FoundationCheck)),
        page({ path: "dev/speaker-review" }, documentTitle(), lazyLoader(async () => (await import("./routes/dev/ReviewFixtures")).ReviewFixtures)),
      ]
    : []),
  ...(import.meta.env.DEV
    ? [page({ path: "dev/dialog-leak" }, documentTitle(), lazyLoader(async () => (await import("./routes/dev/DialogLeakFixture")).DialogLeakFixture))]
    : []),
];

export const router = createBrowserRouter([
  {
    Component: Root,
    HydrateFallback: RootHydrateFallback,
    children: [
      {
        // A page that cannot be shown (its code is gone, or it threw) is replaced by this, inside the frame.
        ErrorBoundary: RouteError,
        children: [
          page({ index: true }, documentTitle("Logga in"), pageCode(() => import("./routes/LoginPage"))),
          page({ path: "flows" }, documentTitle("Välj ett flöde"), pageCode(() => import("./routes/FlowsPage"))),
          // The page sets its own titles as it loads; this is what stands until then.
          page({ path: "flows/:id" }, documentTitle(), flowPageCode),
          page({ path: "inloggad" }, documentTitle("Inloggad igen"), pageCode(() => import("./routes/SignedInAgain"))),
          ...fixtures,
          // Any other address: the page says it does not exist, with the way to the start.
          { path: "*", handle: { title: documentTitle("Sidan finns inte") } satisfies RouteHandle, Component: NotFound },
        ],
      },
    ],
  },
]);
