import { useEffect, useState } from "react";

/** How long a wait with no answer goes on before the page says so and offers a way on. */
export const SLOW_WAIT_MS = 15_000;

/** The wait's one clock and status, shared by session checks and flow pages. */
export function useSlowWait(onRetry: () => void) {
  const [stage, setStage] = useState<"quiet" | "slow" | "retrying">("quiet");
  const [round, setRound] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => setStage("slow"), SLOW_WAIT_MS);
    return () => clearTimeout(timer);
  }, [round]);
  return {
    visible: stage !== "quiet",
    said: stage === "quiet" ? "" : stage === "slow" ? "Det tar längre tid än vanligt." : "Försöker igen.",
    retry: () => {
      setStage("retrying");
      setRound((n) => n + 1);
      onRetry();
    },
  };
}
