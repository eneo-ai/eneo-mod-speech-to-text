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
import { PRODUCT_NAME } from "@/lib/product";

/**
 * The page where the session's answer did not come (the device has no network, the module is down): it says which, in
 * the words of the page's connection notice, and offers another try, at the address the person opened, so a link into a
 * run is still there when the module is back.
 */
export function ModuleUnreachable({ onRetry, retried = false }: { onRetry: () => void; retried?: boolean }) {
  // Shown again after a Försök igen that failed: the new page's Försök igen takes the focus the pressed one had.
  const retry = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (retried) retry.current?.focus();
  }, []);
  return (
    <ModuleShell label={PRODUCT_NAME} heading={<Brand />}>
      <Layout height="auto" contentWidth={640} padding={4}>
        <LayoutContent isScrollable={false}>
          <VStack gap={4} paddingBlockStart={6}>
            <VisuallyHidden as="h1">{PRODUCT_NAME}</VisuallyHidden>
            <Banner status="error" title={connectionLost()} collapsible={false} />
            <HStack>
              <Button ref={retry} label="Försök igen" onClick={onRetry} />
            </HStack>
          </VStack>
        </LayoutContent>
      </Layout>
    </ModuleShell>
  );
}
