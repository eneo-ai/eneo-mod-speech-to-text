import { Center } from "@astryxdesign/core/Center";
import { Spinner } from "@astryxdesign/core/Spinner";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { Brand } from "@/components/Brand";
import { ModuleShell } from "@/kit/ModuleShell";
import { PRODUCT_NAME } from "@/lib/product";

/**
 * The page while it waits: the bar, and a spinner that says so. AuthGate shows it until the session has answered, and
 * the router shows it while the first page's code arrives, so no frame is blank. Its own module, so that the router
 * does not load the session's code for it.
 */
export function LoadingShell() {
  return (
    <ModuleShell label={PRODUCT_NAME} heading={<Brand />}>
      <VisuallyHidden as="h1">{PRODUCT_NAME}</VisuallyHidden>
      <Center minHeight="60dvh">
        <Spinner size="lg" aria-label="Laddar" />
      </Center>
    </ModuleShell>
  );
}
