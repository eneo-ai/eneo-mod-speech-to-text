import { CircleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { BackToFlows } from "@/components/flow/BackToFlows";
import type { Problem } from "@/lib/flow-session";

/** What happened and what to do next, with "Försök igen" when trying again can help. */
export function ProblemAlert({ problem, onRetry }: { problem: Problem; onRetry?: () => void }) {
  return (
    <Alert>
      <CircleAlert aria-hidden />
      <AlertTitle className="text-[15px] font-semibold leading-snug text-ink">{problem.title}</AlertTitle>
      {problem.detail && <AlertDescription className="text-[15px] text-ink-soft">{problem.detail}</AlertDescription>}
      {((problem.retry && onRetry) || problem.back) && (
        // In a row of their own, so the alert's text indent lines them up instead of padding them.
        <div className="mt-3 flex flex-wrap gap-3">
          {problem.retry && onRetry && (
            <Button type="button" variant="outline" onClick={onRetry}>
              Försök igen
            </Button>
          )}
          {problem.back && (
            <BackToFlows variant="outline" size="default" />
          )}
        </div>
      )}
    </Alert>
  );
}
