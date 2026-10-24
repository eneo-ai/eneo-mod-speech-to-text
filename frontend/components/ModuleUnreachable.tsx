import { useEffect, useRef } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { Brand } from "@/components/Brand";
import { ModuleShell } from "@/kit/ModuleShell";
import { connectionLost } from "@/lib/online-status";
import { documentTitle, PRODUCT_NAME } from "@/lib/product";
import { moveFocusToHeading } from "@/routes/RouteEffects";

/**
 * The page where the session's answer did not come (the device has no network, the module is down): it says which, in
 * the words of the page's connection notice, and offers another try, at the address the person opened, so a link into a
 * run is still there when the module is back.
 */
export function ModuleUnreachable({ onRetry, retried = false }: { onRetry: () => void; retried?: boolean }) {
  // Shown again after a Försök igen that failed: the new page's Försök igen takes the focus the pressed one had.
  const retry = useRef<HTMLButtonElement>(null);
  // Shown in place of a page whose link took the focus with it: its heading takes it, so the person starts from here. It
  // says nothing of the route being ready, so the page that replaces it when the module answers gets the navigation's
  // focus and announcement then (routes/RouteEffects).
  useEffect(() => {
    if (retried) retry.current?.focus();
    else moveFocusToHeading();
  }, []);
  const lost = connectionLost();
  // The tab says it as the notice does, without its period and with the product's name, or the words alone where they
  // name the product already. The route's own title is back when the page goes.
  const said = lost.replace(/\.$/, "");
  const title = said.includes(PRODUCT_NAME) ? said : documentTitle(said);
  // ponytail: useDocumentTitle inline; its module (flow/recording-hooks) would bring the recorder into every page's first
  // load (lib/first-load.test.ts). Move that hook to a module of its own, with its callers in routes/, to share it.
  useEffect(() => {
    const before = document.title;
    document.title = title;
    return () => {
      if (document.title === title) document.title = before;
    };
  }, [title]);
  return (
    <ModuleShell label={PRODUCT_NAME} heading={<Brand />}>
      <Layout height="auto" contentWidth={640} padding={4}>
        <LayoutContent isScrollable={false}>
          <VStack gap={4} paddingBlockStart={6}>
            <VisuallyHidden as="h1">{PRODUCT_NAME}</VisuallyHidden>
            <Banner status="error" title={lost} collapsible={false} />
            <HStack>
              <Button ref={retry} label="Försök igen" onClick={onRetry} />
            </HStack>
          </VStack>
        </LayoutContent>
      </Layout>
    </ModuleShell>
  );
}
