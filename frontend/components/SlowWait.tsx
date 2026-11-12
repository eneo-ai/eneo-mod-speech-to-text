import type { ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { ActionRow } from "@/components/ActionRow";
import { useSlowWait } from "@/lib/slow-wait";

/**
 * What a page shows beside a wait that has no end in sight (a flow, the flow list or a run that is being read): nothing
 * while it is short, then, after 15 seconds since this was mounted, that it takes longer than usual
 * and the ways on, trying again and the way back. Trying again keeps the button where it was and judges the wait afresh.
 */
export function SlowWait({
  onRetry,
  back,
  label = "Försök igen",
}: {
  onRetry: () => void;
  /** The page's way back, when there is one. */
  back?: ReactNode;
  /** "Försök nu" where the page already tries again by itself and says so: the button asks for it now. */
  label?: string;
}) {
  const { visible, said, retry } = useSlowWait(onRetry);
  // The status region is there from the start, empty: a region that arrives with its words is not reliably read out.
  const status = (
    <VisuallyHidden as="p" role="status">
      {said}
    </VisuallyHidden>
  );
  return (
    <>
      {status}
      {visible && (
        <VStack gap={3}>
          {/* Read once, by the region above. */}
          <Text as="p" aria-hidden>
            {said}
          </Text>
          <ActionRow>
            {back}
            <Button
              label={label}
              variant="primary"
              onClick={retry}
            />
          </ActionRow>
        </VStack>
      )}
    </>
  );
}
