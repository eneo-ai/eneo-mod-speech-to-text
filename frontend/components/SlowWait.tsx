import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { ActionRow } from "@/components/ActionRow";
import { BackToFlows } from "@/components/flow/BackToFlows";

/** How long a wait with no answer goes on before the page says so and offers a way on. */
export const SLOW_WAIT_MS = 15_000;

/**
 * What a page shows beside a wait that has no end in sight (a flow, the flow list or a run that is being read): nothing
 * while it is short, then, once it has lasted SLOW_WAIT_MS since this was mounted, that it takes longer than usual
 * and the ways on, trying again and the way back. Trying again keeps the button where it was and judges the wait afresh.
 */
export function SlowWait({
  onRetry,
  flows = true,
  label = "Försök igen",
}: {
  onRetry: () => void;
  /** The page is not the flow list itself, so it can offer the way back to it. */
  flows?: boolean;
  /** "Försök nu" where the page already tries again by itself and says so: the button asks for it now. */
  label?: string;
}) {
  const [stage, setStage] = useState<"quiet" | "slow" | "retrying">("quiet");
  const [round, setRound] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => setStage("slow"), SLOW_WAIT_MS);
    return () => clearTimeout(timer);
  }, [round]);
  const said = stage === "quiet" ? "" : stage === "slow" ? "Det tar längre tid än vanligt." : "Försöker igen.";
  // The status region is there from the start, empty: a region that arrives with its words is not reliably read out.
  const status = (
    <VisuallyHidden as="p" role="status">
      {said}
    </VisuallyHidden>
  );
  return (
    <>
      {status}
      {stage !== "quiet" && (
        <VStack gap={3}>
          {/* Read once, by the region above. */}
          <Text as="p" aria-hidden>
            {said}
          </Text>
          <ActionRow>
            {flows && <BackToFlows size="md" />}
            <Button
              label={label}
              variant="primary"
              onClick={() => {
                setStage("retrying");
                setRound((n) => n + 1);
                onRetry();
              }}
            />
          </ActionRow>
        </VStack>
      )}
    </>
  );
}
