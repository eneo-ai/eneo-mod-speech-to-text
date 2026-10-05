import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { Brand } from "@/components/Brand";
import { ModuleShell } from "@/kit/ModuleShell";
import { PRODUCT_NAME } from "@/lib/product";

/** What a page says when the module could not be asked who is signed in. */
export const UNREACHABLE = "Kunde inte kontakta modulen. Försök igen.";

/**
 * The page where the session's answer did not come (the module is down, the connection dropped): it says so and offers
 * another try, at the address the person opened, so a link into a run is still there when the module is back.
 */
export function ModuleUnreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <ModuleShell label={PRODUCT_NAME} heading={<Brand />}>
      <Layout height="auto" contentWidth={640} padding={4}>
        <LayoutContent isScrollable={false}>
          <VStack gap={4} paddingBlockStart={6}>
            <VisuallyHidden as="h1">{PRODUCT_NAME}</VisuallyHidden>
            <Banner status="error" title={UNREACHABLE} collapsible={false} />
            <HStack>
              <Button label="Försök igen" onClick={onRetry} />
            </HStack>
          </VStack>
        </LayoutContent>
      </Layout>
    </ModuleShell>
  );
}
