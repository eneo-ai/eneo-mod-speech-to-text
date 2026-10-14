import type { ReactNode } from "react";
import { LoadFailure } from "@/components/LoadFailure";
import { lazyLoader, useLoaded } from "@/lib/lazy-component";
import { RunOpening } from "./RunProgress";

type Views = typeof import("./RunViews");

// A run's result (its player, document and files), its review and its failure are most of the flow page's code, and a
// page that records or uploads shows none of them: they are fetched when a run is opened, while the run is read.
const views = lazyLoader<Views>(() => import("./RunViews"));

/** Fetches the run views ahead of the run, so they are there when it has been read. */
export const preloadRunViews = () => void views.load().catch(() => undefined);

/** Draws `children` with the run views, the run's placeholder until they have arrived, or the person's reload if they cannot. */
export function WithRunViews({ children }: { children: (views: Views) => ReactNode }) {
  const { value, failed } = useLoaded(views);
  if (value) return children(value);
  if (failed) return <LoadFailure>Körningen kunde inte visas, den kunde inte läsas in.</LoadFailure>;
  return <RunOpening onRetry={() => window.location.reload()} />;
}
