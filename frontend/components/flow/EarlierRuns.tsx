import { CheckCircle2, Clock, History, MinusCircle, XCircle, type LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { pendingReviews, type EarlierRunsSnapshot } from "@/lib/earlier-runs";
import type { FlowRunSummary } from "@/lib/api";
import { formatDay, formatRelativeDate } from "@/lib/format";
import { runOutcome, runStatusLabel } from "@/lib/run-progress";
import { useNarrowerThan } from "./useRoomInRow";

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
  const words = pendingReviewWords(list);
  const newest = pendingReviews(list.runs)[0];
  if (!words || !newest) return null;
  return (
    // A note, not a live region: it arrives with its words when the list does, which a screen reader does not reliably
    // read out. The setup's own status region, there from the start, says it (FlowInput, pendingReviewSaid).
    <Banner
      role="note"
      status="info"
      collapsible={false}
      title={words.title}
      description={words.description}
      endContent={
        // Named as the list's own Granska, so the two say which run.
        <Button label={words.which} variant="secondary" onClick={() => onOpen(newest.id)}>
          Granska
        </Button>
      }
    />
  );
}

/** Which run, by the name and the day its form gave it ("Testmöte 2, 1 okt"); empty when it has neither. */
function runName(run: FlowRunSummary): string {
  return [run.run_label, run.run_date ? formatDay(run.run_date) : ""].filter(Boolean).join(", ");
}

/** What the notice of runs waiting for the person's review says, or null while none waits. */
function pendingReviewWords(list: EarlierRunsSnapshot) {
  const waiting = pendingReviews(list.runs);
  const [newest] = waiting;
  if (!newest) return null;
  const when = newest.created_at ? formatRelativeDate(newest.created_at) : "";
  const name = runName(newest);
  const started = when ? `startad ${when}` : "";
  const named = name ? [name, started].filter(Boolean).join(", ") : started.replace(/^./, (c) => c.toUpperCase());
  return {
    which: name ? `Granska, ${name}, ${when}` : `Granska, körningen ${when}`,
    title: waiting.length === 1 ? "En körning väntar på din granskning" : `${waiting.length} körningar väntar på din granskning`,
    description: `${named ? `${named}. ` : ""}Den avbryts om den inte granskas i tid.`,
  };
}

/** The notice of runs waiting for the person's review as one sentence for a status region, or "" while none waits. */
export function pendingReviewSaid(list: EarlierRunsSnapshot): string {
  const words = pendingReviewWords(list);
  return words ? `${words.title}. ${words.description}` : "";
}

/**
 * "Tidigare körningar" at the setup's top, where the list itself ends the working card, below the form: a press brings
 * the list into view and gives its heading the focus. Only while the list has runs to show.
 */
export function ToEarlierRuns({ list }: { list: EarlierRunsSnapshot }) {
  if (!list.runs.some((run) => run.purpose !== "test")) return null;
  const show = () => {
    const heading = document.getElementById("earlier-runs");
    heading?.scrollIntoView({ block: "start" });
    heading?.focus({ preventScroll: true });
  };
  return (
    <HStack>
      <Button variant="ghost" icon={<Icon icon={History} />} label="Tidigare körningar" onClick={show} />
    </HStack>
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
  // A row is its icon, the date over the state, and the action at its end: 14 rem of the root text holds the longest of
  // them. Narrower (the reader's largest text, a phone's 200 % zoom) the date and the state take the row's whole width
  // and the action stands under them, so neither is cut off; the state's word says what the icon would.
  const room = useNarrowerThan(14);
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
      <Heading level={2} id="earlier-runs" tabIndex={-1}>
        Tidigare körningar
      </Heading>
      <List hasDividers ref={room.ref}>
        {shown.map((run) => {
          const outcome = runOutcome(run.status);
          const [glyph, color, action] = outcome
            ? [...OUTCOME[outcome], "Öppna"]
            : ([Clock, "accent", run.status === "awaiting_review" ? "Granska" : "Följ"] as const);
          const when = run.created_at ? formatRelativeDate(run.created_at) : "";
          const When = when.replace(/^./, (c) => c.toUpperCase());
          // A named run (the meeting's name and day) is listed by them, and when it ran goes with its state.
          const name = runName(run);
          // A node, not a string: Astryx cuts a string label to one line, and a meeting's name may be long, or the
          // reader's text large; it wraps instead.
          const title = <>{name || When}</>;
          const state = name ? `${When} · ${runStatusLabel(run.status)}` : runStatusLabel(run.status);
          // The name says which run, for a screen reader that lists the buttons, by when too (a weekly meeting repeats
          // its name); the words say what it does.
          const open = (
            <Button
              label={name ? `${action}, ${name}, ${when}` : `${action}, körningen ${when}`}
              variant="secondary"
              size="sm"
              data-open-run
              onClick={() => onOpen(run.id)}
            >
              {action}
            </Button>
          );
          return room.narrow ? (
            <ListItem
              key={run.id}
              label={title}
              description={
                <VStack gap={2} align="start">
                  <span>{state}</span>
                  {open}
                </VStack>
              }
            />
          ) : (
            <ListItem
              key={run.id}
              label={title}
              description={<>{state}</>}
              startContent={<Icon icon={glyph} color={color} />}
              endContent={open}
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
