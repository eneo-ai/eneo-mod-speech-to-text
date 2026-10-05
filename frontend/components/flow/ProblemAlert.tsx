import { useEffect, useRef } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { BackToFlows } from "@/components/flow/BackToFlows";
import type { Problem } from "@/lib/flow-session";

/**
 * What happened and what to do next, with "Försök igen" when trying again can help. A problem without a detail is
 * one message, read as text rather than as a heading. `reveal` scrolls it into view when it appears, for an answer
 * to a button that may be far from it (the docked Skapa dokument on a phone, whose clearance globals.css owns). The scroll
 * is a jump: a smooth one runs to the offset it computed when it began, so a notice that appears above the alert while it
 * runs (the offline notice) leaves the alert under the dock, where the browser would have kept it in place by itself.
 */
export function ProblemAlert({
  problem,
  onRetry,
  reveal = false,
  focusRetry = false,
}: {
  problem: Problem;
  onRetry?: () => void;
  reveal?: boolean;
  /** The answer to a Försök igen that failed again: its own Försök igen takes the focus the pressed one had (WCAG 2.4.3). */
  focusRetry?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!reveal) return;
    ref.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [reveal, problem]);
  useEffect(() => {
    if (focusRetry) retryButton.current?.focus();
  }, []);

  const actions = (problem.retry && onRetry) || problem.back;
  // A warning: "try again" is not a failure of the person's. Title and detail are plain text, not headings.
  return (
    <Banner
      ref={ref}
      status="warning"
      title={problem.title}
      description={problem.detail}
      collapsible={false}
      endContent={
        actions ? (
          <HStack gap={2} wrap="wrap" align="center">
            {problem.retry && onRetry && <Button ref={retryButton} label="Försök igen" variant="secondary" onClick={onRetry} />}
            {problem.back && <BackToFlows size="md" />}
          </HStack>
        ) : undefined
      }
    />
  );
}
