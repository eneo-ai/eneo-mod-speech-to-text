"use client";

import { CheckCircle2, Clock, MinusCircle, XCircle, type LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import type { EarlierRunsSnapshot } from "@/lib/earlier-runs";
import { formatRelativeDate } from "@/lib/format";
import { runOutcome, runStatusLabel } from "@/lib/run-progress";
import { cn } from "@/lib/utils";

const OUTCOME: Record<string, [LucideIcon, string, string]> = {
  succeeded: [CheckCircle2, "text-ok", "Öppna"],
  failed: [XCircle, "text-destructive", "Öppna"],
  cancelled: [MinusCircle, "text-muted-foreground", "Öppna"],
};

/** This flow's latest runs, so yesterday's document is one tap away, and more a page at a time. */
export function EarlierRuns({
  list,
  onOpen,
  onMore,
  className,
}: {
  list: EarlierRunsSnapshot;
  onOpen: (runId: string) => void;
  /** "Visa fler körningar": the next page. */
  onMore?: () => void;
  className?: string;
}) {
  // Test runs started from Eneo's editor are not this user's documents.
  const shown = list.runs.filter((run) => run.purpose !== "test");
  const section = useRef<HTMLElement>(null);
  // After "Visa fler körningar", focus goes to the first run it added.
  const firstNew = useRef<number | null>(null);
  useEffect(() => {
    const index = firstNew.current;
    if (index === null || shown.length <= index) return;
    firstNew.current = null;
    section.current?.querySelectorAll<HTMLButtonElement>("[data-open-run]")[index]?.focus();
  }, [shown.length]);
  if (shown.length === 0 && !list.hasMore && !list.failed) return null;
  return (
    <section ref={section} aria-labelledby="earlier-runs" className={cn("flex flex-col gap-3", className)}>
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
                <Button type="button" variant="outline" data-open-run onClick={() => onOpen(run.id)}>
                  {action}
                  <span className="sr-only">, körningen {when}</span>
                </Button>
              </ItemActions>
            </Item>
          );
        })}
      </ItemGroup>
      {list.failed === "first" && onMore && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-[13px] text-ink-soft">Tidigare körningar kunde inte hämtas.</p>
          <Button type="button" variant="outline" disabled={list.loading} onClick={onMore}>
            Försök igen
          </Button>
        </div>
      )}
      {list.hasMore && list.failed !== "first" && onMore && (
        <div className="flex flex-col items-start gap-2">
          {list.failed === "next" && <p className="text-[13px] text-ink-soft">Fler körningar kunde inte hämtas. Försök igen.</p>}
          <Button
            type="button"
            variant="outline"
            disabled={list.loading}
            onClick={() => {
              firstNew.current = shown.length;
              onMore();
            }}
          >
            {list.loading ? "Hämtar körningar…" : "Visa fler körningar"}
          </Button>
        </div>
      )}
    </section>
  );
}
