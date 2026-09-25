"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AuthGate, useAuthenticatedUser } from "@/components/AuthGate";
import { AppHeader } from "@/components/AppHeader";
import { FlowList, FlowListSkeleton } from "@/components/FlowList";
import { FRAME } from "@/components/frame";
import { ProblemAlert } from "@/components/flow/ProblemAlert";
import { useDocumentTitle } from "@/components/flow/recording-hooks";
import { UnsentRecordings, useUnsentRecordings } from "@/components/UnsentRecordings";
import { getConfig } from "@/lib/api";
import { errorAdvice, type ErrorAdvice } from "@/lib/errors";
import { cn } from "@/lib/utils";
import {
  DISCOVERY_PAGE_CAP,
  DISCOVERY_PAGE_SIZE,
  discoverConfiguredFlows,
  type FlowSpaceGroup,
} from "@/lib/flow-discovery";
import { browserStorage, lastUsedFlow } from "@/lib/flow-session";

export default function FlowsPage() {
  return (
    <AuthGate>
      <FlowsListPage />
    </AuthGate>
  );
}

function FlowsListPage() {
  const router = useRouter();
  const user = useAuthenticatedUser();
  const unsent = useUnsentRecordings(user.id);
  useDocumentTitle("Välj ett flöde · Tal till text");
  const [lastFlowId, setLastFlowId] = useState<string | null>(null);
  useEffect(() => setLastFlowId(lastUsedFlow(browserStorage(), user.id)), [user.id]);
  const [groups, setGroups] = useState<FlowSpaceGroup[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [problem, setProblem] = useState<ErrorAdvice | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setProblem(null);
    setAttempt((n) => n + 1);
  }, []);

  // One read of the published flows in all the user's spaces, page by page;
  // no spaces calls and no run contract per flow. The contract is fetched
  // when a flow is opened.
  useEffect(() => {
    let cancelled = false;
    setGroups(null);
    getConfig()
      .then((config) => discoverConfiguredFlows(config))
      .then(({ groups: found, truncated: cut }) => {
        if (cancelled) return;
        setTruncated(cut);
        setGroups(found);
      })
      .catch((error) => !cancelled && setProblem(errorAdvice(error)));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const empty = groups !== null && groups.every((group) => group.flows.length === 0);

  return (
    <>
      <AppHeader />
      <main id="innehall" className={cn(FRAME, "flex flex-col gap-8 pb-16 pt-2 md:pt-6 lg:pt-8")}>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-ink md:text-[34px]">
          Välj ett flöde
        </h1>

        {unsent.length > 0 && (
          <UnsentRecordings
            recordings={unsent}
            withFlowName
            onSend={(recording) => router.push(`/flows/${recording.flowId}?recording=${recording.id}`)}
          />
        )}

        {problem ? (
          <ProblemAlert
            problem={{ title: "Flödena kunde inte visas.", detail: problem.message, retry: problem.retry }}
            onRetry={retry}
          />
        ) : groups === null ? (
          <>
            <p role="status" className="sr-only">
              Laddar flödena…
            </p>
            <FlowListSkeleton />
          </>
        ) : empty ? (
          <p className="max-w-prose text-[17px] leading-relaxed text-ink-soft">
            Det finns inga publicerade flöden som du kan använda än. När ett flöde publiceras i Eneo visas det här.
          </p>
        ) : (
          <FlowList groups={groups} lastFlowId={lastFlowId} />
        )}

        {truncated && (
          <p className="text-[15px] text-ink-soft">
            Visar de första {(DISCOVERY_PAGE_SIZE * DISCOVERY_PAGE_CAP).toLocaleString("sv-SE")} flödena.
          </p>
        )}
      </main>
    </>
  );
}
