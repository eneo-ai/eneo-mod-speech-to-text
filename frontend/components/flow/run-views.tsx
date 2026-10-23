import type { ReactNode } from "react";
import { Heading } from "@astryxdesign/core/Heading";
import { VStack } from "@astryxdesign/core/Stack";
import { LoadFailure } from "@/components/LoadFailure";
import { lazyLoader, useLoaded } from "@/lib/lazy-component";
import { RunOpening } from "./RunProgress";
import { StateCard } from "./StateCard";
import { usePhaseHeading } from "./usePhaseHeading";

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
  if (failed) return <ViewsFailed />;
  return <RunOpening onRetry={() => window.location.reload()} />;
}

/** The run's page when its code cannot come (a tab open across a deploy): a page of its own, as a route's that cannot. */
function ViewsFailed() {
  const heading = usePhaseHeading("Körningen kunde inte visas");
  return (
    <StateCard>
      <VStack gap={4}>
        <Heading level={1} ref={heading} tabIndex={-1}>
          Körningen kunde inte visas.
        </Heading>
        <LoadFailure>Tal till text kan ha uppdaterats sedan sidan öppnades.</LoadFailure>
      </VStack>
    </StateCard>
  );
}
