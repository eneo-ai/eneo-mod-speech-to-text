import { CheckCircle2, Clock, MinusCircle, XCircle, type LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { pendingReviews, type EarlierRunsSnapshot } from "@/lib/earlier-runs";
import { formatRelativeDate } from "@/lib/format";
import { runOutcome, runStatusLabel } from "@/lib/run-progress";

const OUTCOME: Record<string, [LucideIcon, "success" | "error" | "secondary"]> = {
  succeeded: [CheckCircle2, "success"],
  failed: [XCircle, "error"],
  cancelled: [MinusCircle, "secondary"],
};

/**
 * A run of this flow that waits for the person's review, said above the setup's work, where a person who came to start
 * another run sees it: Eneo cancels a review that is not done in time. The newest one is opened from here; the list of
 * earlier runs has them all.
 */
export function PendingReview({ list, onOpen }: { list: EarlierRunsSnapshot; onOpen: (runId: string) => void }) {
  const waiting = pendingReviews(list.runs);
  const [newest] = waiting;
  if (!newest) return null;
  const when = newest.created_at ? formatRelativeDate(newest.created_at) : "";
  return (
    <Banner
      status="info"
      collapsible={false}
      title={waiting.length === 1 ? "En körning väntar på din granskning" : `${waiting.length} körningar väntar på din granskning`}
      description={`${when ? `Startad ${when}. ` : ""}Den avbryts om den inte granskas i tid.`}
      endContent={
        // Named as the list's own Granska, so the two say which run.
        <Button label={`Granska, körningen ${when}`} variant="secondary" onClick={() => onOpen(newest.id)}>
          Granska
        </Button>
      }
    />
  );
}

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
      <List hasDividers>
        {shown.map((run) => {
          const outcome = runOutcome(run.status);
          const [glyph, color, action] = outcome
            ? [...OUTCOME[outcome], "Öppna"]
            : ([Clock, "accent", run.status === "awaiting_review" ? "Granska" : "Följ"] as const);
          const when = run.created_at ? formatRelativeDate(run.created_at) : "";
          return (
            <ListItem
              key={run.id}
              label={when.replace(/^./, (c) => c.toUpperCase())}
              description={runStatusLabel(run.status)}
              startContent={<Icon icon={glyph} color={color} />}
              endContent={
                // The name says which run, for a screen reader that lists the buttons; the words say what it does.
                <Button label={`${action}, körningen ${when}`} variant="secondary" size="sm" data-open-run onClick={() => onOpen(run.id)}>
                  {action}
                </Button>
              }
            />
          );
        })}
      </List>
      {list.failed === "first" && onMore && (
        <VStack gap={2} align="start">
          <Text as="p" type="supporting">
            Tidigare körningar kunde inte hämtas.
          </Text>
          <Button label="Försök igen" variant="secondary" isDisabled={list.loading} onClick={onMore} />
        </VStack>
      )}
      {list.hasMore && list.failed !== "first" && onMore && (
        <VStack gap={2} align="start">
          {list.failed === "next" && (
            <Text as="p" type="supporting">
              Fler körningar kunde inte hämtas. Försök igen.
            </Text>
          )}
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
