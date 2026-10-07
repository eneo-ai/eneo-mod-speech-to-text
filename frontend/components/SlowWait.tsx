import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
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
}: {
  onRetry: () => void;
  /** The page is not the flow list itself, so it can offer the way back to it. */
  flows?: boolean;
}) {
  const [stage, setStage] = useState<"quiet" | "slow" | "retrying">("quiet");
  const [round, setRound] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => setStage("slow"), SLOW_WAIT_MS);
    return () => clearTimeout(timer);
  }, [round]);
  if (stage === "quiet") return null;
  return (
    <VStack gap={3}>
      <Text as="p" role="status">
        {stage === "slow" ? "Det tar längre tid än vanligt." : "Försöker igen."}
      </Text>
      <HStack gap={3} wrap="wrap">
        <Button
          label="Försök igen"
          variant="primary"
          onClick={() => {
            setStage("retrying");
            setRound((n) => n + 1);
            onRetry();
          }}
        />
        {flows && <BackToFlows size="md" />}
      </HStack>
    </VStack>
  );
}
