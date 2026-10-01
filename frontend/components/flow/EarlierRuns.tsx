"use client";

import { CheckCircle2, Clock, MinusCircle, XCircle, type LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { EarlierRunsSnapshot } from "@/lib/earlier-runs";
import { formatRelativeDate } from "@/lib/format";
import { runOutcome, runStatusLabel } from "@/lib/run-progress";

const OUTCOME: Record<string, [LucideIcon, "success" | "error" | "secondary", string]> = {
  succeeded: [CheckCircle2, "success", "Öppna"],
  failed: [XCircle, "error", "Öppna"],
  cancelled: [MinusCircle, "secondary", "Öppna"],
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
    <VStack as="section" ref={section} aria-labelledby="earlier-runs" gap={3} className={className}>
      <Heading level={2} id="earlier-runs">
        Tidigare körningar
      </Heading>
      <List>
        {shown.map((run) => {
          const outcome = runOutcome(run.status);
          const [icon, color, action] = outcome
            ? OUTCOME[outcome]
            : [Clock, "accent" as const, run.status === "awaiting_review" ? "Granska" : "Följ"];
          const when = run.created_at ? formatRelativeDate(run.created_at) : "";
          return (
            <ListItem
              key={run.id}
              label={when.replace(/^./, (c) => c.toUpperCase())}
              description={runStatusLabel(run.status)}
              startContent={<Icon icon={icon} color={color} />}
              endContent={
                // The words the eye reads are the action; the button's name says which run it opens.
                <Button label={`${action}, körningen ${when}`} variant="secondary" data-open-run onClick={() => onOpen(run.id)}>
                  {action}
                </Button>
              }
            />
          );
        })}
      </List>
      {list.failed === "first" && onMore && (
        <VStack gap={2} hAlign="start">
          <Text type="supporting">Tidigare körningar kunde inte hämtas.</Text>
          <Button label="Försök igen" variant="secondary" isDisabled={list.loading} onClick={onMore} />
        </VStack>
      )}
      {list.hasMore && list.failed !== "first" && onMore && (
        <VStack gap={2} hAlign="start">
          {list.failed === "next" && <Text type="supporting">Fler körningar kunde inte hämtas. Försök igen.</Text>}
          <Button
            label={list.loading ? "Hämtar körningar…" : "Visa fler körningar"}
            variant="secondary"
            isDisabled={list.loading}
            onClick={() => {
              firstNew.current = shown.length;
              onMore();
            }}
          />
        </VStack>
      )}
    </VStack>
  );
}
