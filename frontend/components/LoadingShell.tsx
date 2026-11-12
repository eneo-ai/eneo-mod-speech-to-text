import { Center } from "@astryxdesign/core/Center";
import { Spinner } from "@astryxdesign/core/Spinner";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { Brand } from "@/components/Brand";
import { SessionWait } from "@/components/SessionWait";
import { ModuleShell } from "@/kit/ModuleShell";
import { PRODUCT_NAME } from "@/lib/product";
import styles from "@/components/LoadingShell.module.css";

/**
 * The page while it waits: the bar, and a spinner that says so. AuthGate shows it until the session has answered, and
 * the router shows it while the first page's code arrives, so no frame is without the bar. Its own module, so that the router
 * does not load the session's code for it. With `onRetry` (a question that may hang until the request gives up, 90 s), the wait
 * says after 15 s that it takes longer than usual and offers to ask again.
 */
export function LoadingShell({ onRetry }: { onRetry?: () => void } = {}) {
  return (
    <ModuleShell label={PRODUCT_NAME} heading={<Brand />}>
      <VisuallyHidden as="h1">{PRODUCT_NAME}</VisuallyHidden>
      {/* Most answers come within a moment: the spinner waits that long before it shows. */}
      <Center minHeight="60dvh" className={styles.wait}>
        <VStack hAlign="center" gap={4}>
          <Spinner size="lg" aria-label="Laddar" />
          {onRetry && <SessionWait onRetry={onRetry} />}
        </VStack>
      </Center>
    </ModuleShell>
  );
}
