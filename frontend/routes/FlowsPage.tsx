import { useNavigate } from "react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { AccountMenu } from "@/components/AccountMenu";
import { HeaderBrand } from "@/components/HeaderBrand";
import { AuthGate, useAuthenticatedUser } from "@/components/AuthGate";
import { FlowList, FlowListSkeleton } from "@/components/FlowList";
import listStyles from "@/components/FlowList.module.css";
import { ProblemAlert } from "@/components/flow/ProblemAlert";
import { SlowWait } from "@/components/SlowWait";
import { UnsentRecordings, useEvictable, useUnsentRecordings } from "@/components/UnsentRecordings";
import { VersionInfo } from "@/components/VersionInfo";
import { ModuleShell } from "@/kit/ModuleShell";
import { ASK_ENEO_OWNER, errorAdvice, type ErrorAdvice } from "@/lib/errors";
import {
  DISCOVERY_PAGE_CAP,
  DISCOVERY_PAGE_SIZE,
  discoverFlows,
  listCreateLabels,
  type FlowSpaceGroup,
} from "@/lib/flow-discovery";
import { browserStorage } from "@/lib/browser-storage";
import { continueRecordingAddress, sendRecordingAddress } from "@/lib/flow-address";
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

  useRouteReady(groups !== null || problem !== null);

  const empty = groups !== null && groups.every((group) => group.flows.length === 0);
  const createLabel = listCreateLabels(groups);

  // A flow is what a person opens from here: once the list is shown, its page's code is fetched while the browser is
  // idle, so opening one does not wait for it, and the list's own answer never waits for that code. Not when the browser
  // asks to save data. The route's own module: nothing of the page runs until it is opened, and a fetch that fails is
  // the route's to say then, as when it fails on the press.
  const listed = groups !== null && !empty;
  useEffect(() => {
    if (!listed || (navigator as { connection?: { saveData?: boolean } }).connection?.saveData) return;
    const idle = window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 1));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const handle = idle(() => void import("./FlowPage").catch(() => undefined));
    return () => cancel(handle);
  }, [listed]);
  // Asked again (Uppdatera, or a Försök igen) and still none: the new Uppdatera takes the focus the pressed button had.
  const refresh = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (empty && attempt > 0) refresh.current?.focus();
  }, [empty, attempt]);

  return (
    <ModuleShell label={PRODUCT_NAME} heading={<HeaderBrand />} end={<AccountMenu />}>
      {/* The page's column in the shell's gutter, so the list starts where the bar's brand and a flow's page do; the list
          at a reading width in it. */}
      <Layout height="auto" contentWidth="calc(var(--module-page-width) + var(--spacing-8))" padding={4}>
        <LayoutContent isScrollable={false}>
          <VStack gap={8} className={listStyles.page}>
            <Heading level={1} type="display-3">
              Välj ett flöde
            </Heading>

            <VStack gap={10} className={listStyles.sections}>
            {/* Each action goes on in the recording's flow. The newest recording's main action is the page's one filled
                action: nothing else here is; one recording stands in view with the rest folded, so the flows are in view too. */}
            <UnsentRecordings
              list={unsent}
              withFlowName
              evictable={evictable}
              folded
              sendLabel={(recording) => createLabel(recording.flowId)}
              onSend={(recording) => void navigate(sendRecordingAddress(recording.flowId, recording.id))}
              onContinue={(recording) => void navigate(continueRecordingAddress(recording.flowId, recording.id))}
            />

            {problem ? (
              <ProblemAlert
                problem={{ title: "Flödena kunde inte visas.", detail: problem.message, retry: problem.retry }}
                onRetry={retry}
                focusRetry={attempt > 0}
              />
            ) : groups === null ? (
              <>
                <VisuallyHidden as="p" role="status">
                  Laddar flödena…
                </VisuallyHidden>
                <SlowWait flows={false} onRetry={retry} />
                <FlowListSkeleton />
              </>
            ) : empty ? (
              // An empty list says so in its place, centred and as a status, as the design system's empty state does: of
              // its parts, so the flow list does not fetch that component's own file for a list that is rarely empty. Its
              // icon stands bare above the heading, as the design system's does: in a tile it read as a feature card.
              <Card padding={8} className={listStyles.empty}>
                <VStack role="status" hAlign="center" gap={4}>
                  <Icon icon={AudioLines} size="lg" color="secondary" />
                  <VStack hAlign="center" gap={2}>
                    <Heading level={2} justify="center">
                      Det finns inga publicerade flöden som du kan använda än.
                    </Heading>
                    <Text as="p" color="secondary" justify="center" data-measure>
                      När ett flöde publiceras i Eneo visas det här. {ASK_ENEO_OWNER} om du saknar ett flöde.
                    </Text>
                  </VStack>
                  <Button ref={refresh} label="Uppdatera" onClick={retry} />
                </VStack>
              </Card>
            ) : (
              <FlowList groups={groups} lastFlowId={lastFlowId} />
            )}

            {truncated && (
              <Text as="p" type="supporting">
                Visar de första {(DISCOVERY_PAGE_SIZE * DISCOVERY_PAGE_CAP).toLocaleString("sv-SE")} flödena.
              </Text>
            )}

            {/* Last, and drawn with the list's answer: drawn before it, the list would push it down when it arrives. */}
            {(groups !== null || problem !== null) && <VersionInfo />}
            </VStack>
          </VStack>
        </LayoutContent>
      </Layout>
    </ModuleShell>
  );
}
