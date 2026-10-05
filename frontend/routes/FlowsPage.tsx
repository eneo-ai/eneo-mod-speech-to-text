"use client";

import { useNavigate } from "react-router";
import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { AccountMenu } from "@/components/AccountMenu";
import { HeaderBrand } from "@/components/AppHeader";
import { AuthGate, useAuthenticatedUser } from "@/components/AuthGate";
import { FlowList, FlowListSkeleton } from "@/components/FlowList";
import { ProblemAlert } from "@/components/flow/ProblemAlert";
import { UnsentRecordings, useEvictable, useUnsentRecordings } from "@/components/UnsentRecordings";
import { ModuleShell } from "@/kit/ModuleShell";
import { errorAdvice, type ErrorAdvice } from "@/lib/errors";
import {
  DISCOVERY_PAGE_CAP,
  DISCOVERY_PAGE_SIZE,
  discoverFlows,
  listCreateLabels,
  type FlowSpaceGroup,
} from "@/lib/flow-discovery";
import { browserStorage } from "@/lib/browser-storage";
import { lastUsedFlow } from "@/lib/last-used-flow";
import { useRouteReady } from "@/routes/RouteEffects";
import { PRODUCT_NAME } from "@/lib/product";

export default function FlowsPage() {
  return (
    <AuthGate>
      <FlowsListPage />
    </AuthGate>
  );
}

function FlowsListPage() {
  const navigate = useNavigate();
  const user = useAuthenticatedUser();
  const unsent = useUnsentRecordings(user.id);
  const evictable = useEvictable();
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
    discoverFlows()
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

  // The page has its content when the list has answered, or could not.
  useRouteReady(groups !== null || problem !== null);

  const empty = groups !== null && groups.every((group) => group.flows.length === 0);
  const createLabel = listCreateLabels(groups);

  return (
    <ModuleShell label={PRODUCT_NAME} heading={<HeaderBrand />} end={<AccountMenu />}>
      <Layout height="auto" contentWidth={960} padding={4}>
        <LayoutContent isScrollable={false}>
          <VStack gap={8} paddingBlockStart={4}>
            <Heading level={1}>Välj ett flöde</Heading>

            {unsent.length > 0 && (
              <UnsentRecordings
                recordings={unsent}
                withFlowName
                evictable={evictable}
                sendLabel={(recording) => createLabel(recording.flowId)}
                onSend={(recording) => void navigate(`/flows/${recording.flowId}?recording=${recording.id}`)}
              />
            )}

            {problem ? (
              <ProblemAlert
                problem={{ title: "Flödena kunde inte visas.", detail: problem.message, retry: problem.retry }}
                onRetry={retry}
              />
            ) : groups === null ? (
              <>
                <VisuallyHidden as="p" role="status">
                  Laddar flödena…
                </VisuallyHidden>
                <FlowListSkeleton />
              </>
            ) : empty ? (
              <EmptyState
                headingLevel={2}
                title="Det finns inga publicerade flöden som du kan använda än."
                description="När ett flöde publiceras i Eneo visas det här."
              />
            ) : (
              <FlowList groups={groups} lastFlowId={lastFlowId} />
            )}

            {truncated && (
              <Text as="p" type="supporting">
                Visar de första {(DISCOVERY_PAGE_SIZE * DISCOVERY_PAGE_CAP).toLocaleString("sv-SE")} flödena.
              </Text>
            )}
          </VStack>
        </LayoutContent>
      </Layout>
    </ModuleShell>
  );
}
