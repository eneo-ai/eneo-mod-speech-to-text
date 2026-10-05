import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { Brand } from "@/components/Brand";
import { ModuleShell } from "@/kit/ModuleShell";

/** What a page says when the module could not be asked who is signed in. */
export const UNREACHABLE = "Kunde inte kontakta modulen. Försök igen.";

/**
 * The page where the session's answer did not come (the module is down, the connection dropped): it says so and offers
 * another try, at the address the person opened, so a link into a run is still there when the module is back.
 */
export function ModuleUnreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <ModuleShell label="Tal till text" heading={<Brand />}>
      <VStack gap={4} maxWidth={640}>
        <VisuallyHidden as="h1">Tal till text</VisuallyHidden>
        <Banner status="error" title={UNREACHABLE} collapsible={false} />
        <HStack>
          <Button label="Försök igen" onClick={onRetry} />
        </HStack>
      </VStack>
    </ModuleShell>
  );
}
