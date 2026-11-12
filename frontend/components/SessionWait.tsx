import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { useSlowWait } from "@/lib/slow-wait";

/** A session check has one way on, trying again, and no flow navigation to load before the session is known. */
export function SessionWait({ onRetry }: { onRetry: () => void }) {
  const { visible, said, retry } = useSlowWait(onRetry);
  return (
    <>
      <VisuallyHidden as="p" role="status">{said}</VisuallyHidden>
      {visible && (
        <VStack gap={3}>
          <Text as="p" aria-hidden>{said}</Text>
          <Button label="Försök igen" variant="primary" onClick={retry} />
        </VStack>
      )}
    </>
  );
}
