"use client";

import { CheckCircle2, Clock, MinusCircle, XCircle, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import type { FlowRunSummary } from "@/lib/api";
import { formatRelativeDate } from "@/lib/format";
import { runOutcome, runStatusLabel } from "@/lib/run-progress";
import { cn } from "@/lib/utils";

const OUTCOME: Record<string, [LucideIcon, string, string]> = {
  succeeded: [CheckCircle2, "text-ok", "Öppna"],
  failed: [XCircle, "text-destructive", "Öppna"],
  cancelled: [MinusCircle, "text-muted-foreground", "Öppna"],
};

/** This flow's latest runs, so yesterday's document is one tap away. */
export function EarlierRuns({
  runs,
  onOpen,
  className,
}: {
  runs: readonly FlowRunSummary[];
  onOpen: (runId: string) => void;
  className?: string;
}) {
  // Test runs started from Eneo's editor are not this user's documents.
  const shown = runs.filter((run) => run.purpose !== "test");
  if (shown.length === 0) return null;
  return (
    <section aria-labelledby="earlier-runs" className={cn("flex flex-col gap-3", className)}>
      <h2 id="earlier-runs" className="text-lg font-semibold tracking-tight">
        Tidigare körningar
      </h2>
      <ItemGroup className="gap-2">
        {shown.map((run) => {
          const outcome = runOutcome(run.status);
          const [Icon, tone, action] = outcome
            ? OUTCOME[outcome]
            : [Clock, "text-primary", run.status === "awaiting_review" ? "Granska" : "Följ"];
          const when = run.created_at ? formatRelativeDate(run.created_at) : "";
          return (
            <Item key={run.id} role="listitem" variant="outline" size="sm" className="bg-card">
              <ItemMedia>
                <Icon aria-hidden className={cn("size-5", tone)} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle className="text-[15px] tabular-nums">{when.replace(/^./, (c) => c.toUpperCase())}</ItemTitle>
                <ItemDescription>{runStatusLabel(run.status)}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button type="button" variant="outline" onClick={() => onOpen(run.id)}>
                  {action}
                  <span className="sr-only">, körningen {when}</span>
                </Button>
              </ItemActions>
            </Item>
          );
        })}
      </ItemGroup>
    </section>
  );
}
