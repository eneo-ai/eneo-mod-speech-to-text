import type { ComponentType } from "react";
import { lazyLoader } from "@/lib/lazy-component";

/**
 * The flow page's code: the route's (routes.tsx), and fetched ahead while the flow list is read (routes/FlowsPage.tsx).
 * One loader for both, so a flow whose code the list fetched opens at once, also when the network has gone since.
 */
export const flowPageCode = lazyLoader<ComponentType>(() => import("./FlowPage").then((module) => module.default));
