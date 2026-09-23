import { CircleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { Problem } from "@/lib/flow-session";

/** What happened and what to do next, with "Försök igen" when trying again can help. */
export function ProblemAlert({ problem, onRetry }: { problem: Problem; onRetry?: () => void }) {
  return (
    <Alert>
      <CircleAlert aria-hidden />
      <AlertTitle className="text-[15px] font-semibold text-ink">{problem.title}</AlertTitle>
      {problem.detail && <AlertDescription className="text-[15px] text-ink-soft">{problem.detail}</AlertDescription>}
      {problem.retry && onRetry && (
        <Button type="button" variant="outline" className="mt-3 h-11" onClick={onRetry}>
          Försök igen
        </Button>
      )}
    </Alert>
  );
}
