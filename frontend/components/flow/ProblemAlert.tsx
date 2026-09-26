import { useEffect, useRef } from "react";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { BackToFlows } from "@/components/flow/BackToFlows";
import type { Problem } from "@/lib/flow-session";

/**
 * What happened and what to do next, with "Försök igen" when trying again can help. A problem without a detail is
 * one message, read as text rather than as a heading. `reveal` scrolls it into view when it appears, for an answer
 * to a button that may be far from it (the docked Skapa dokument on a phone, whose clearance globals.css owns).
 */
export function ProblemAlert({ problem, onRetry, reveal = false }: { problem: Problem; onRetry?: () => void; reveal?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!reveal) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    ref.current?.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
  }, [reveal, problem]);

  return (
    <Alert ref={ref} variant="warning">
      <TriangleAlert aria-hidden />
      {problem.detail ? (
        <>
          <AlertTitle>{problem.title}</AlertTitle>
          <AlertDescription>{problem.detail}</AlertDescription>
        </>
      ) : (
        <AlertDescription className="text-ink">{problem.title}</AlertDescription>
      )}
      {((problem.retry && onRetry) || problem.back) && (
        // In a row of their own, so the alert's text indent lines them up instead of padding them.
        <div className="mt-3 flex flex-wrap gap-3">
          {problem.retry && onRetry && (
            <Button type="button" variant="outline" onClick={onRetry}>
              Försök igen
            </Button>
          )}
          {problem.back && <BackToFlows variant="outline" size="default" />}
        </div>
      )}
    </Alert>
  );
}
