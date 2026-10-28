import { ArrowDown, CheckCircle2, Clock, MinusCircle, XCircle, type LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";
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

const capital = (words: string) => words.replace(/^./, (c) => c.toUpperCase());

/**
 * Which run, in the words of its row: by the meeting's name its form gave it, else when it ran; each date said for what
 * it is, "Möte 1 okt" and "startad i går 10:23" (Kaltron's rows). `which` names it for a button that opens it.
 */
function runWords(run: FlowRunSummary, action: string) {
  const when = run.created_at ? formatRelativeDate(run.created_at) : "";
  const day = run.run_date ? formatDay(run.run_date) : "";
  const meeting = day && `möte ${day}`;
  const started = run.run_label && when && `startad ${when}`;
  return {
    title: run.run_label || capital(when),
    // What the title does not say yet; the state comes after it in the list.
    about: capital([meeting, started].filter(Boolean).join(" · ")),
    which: [action, run.run_label || `körningen ${when}`, meeting, started].filter(Boolean).join(", "),
  };
}

/**
 * The runs waiting for the person's review as one sentence for the setup's status region, or "" while none waits: the
 * latest runs list them first, and Eneo cancels a review that is not done in time.
 */
export function pendingReviewSaid(list: EarlierRunsSnapshot): string {
  const waiting = pendingReviews(list.runs);
  const [newest] = waiting;
  if (!newest) return "";
  const when = newest.created_at ? formatRelativeDate(newest.created_at) : "";
  const named = capital([newest.run_label, newest.run_date && `möte ${formatDay(newest.run_date)}`, when && `startad ${when}`].filter(Boolean).join(", "));
  const title = waiting.length === 1 ? "En körning väntar på din granskning" : `${waiting.length} körningar väntar på din granskning`;
  return `${title}. ${named ? `${named}. ` : ""}Den avbryts om den inte granskas i tid.`;
}

/**
 * Runs as rows: each its icon, its title (the meeting's name and day, or when it ran) over the state, and the action at its
 * end.
 */
function RunRows({ runs, onOpen }: { runs: readonly FlowRunSummary[]; onOpen: (runId: string) => void }) {
  // 14 rem of the root text holds a date over a state, and a longer name wraps beside the action. Narrower (the reader's
  // largest text, a phone's 200 % zoom) the title and the state take the row's whole width and the action stands under
  // them, so neither is cut off; the state's word says what the icon would.
  const room = useNarrowerThan(14);
  return (
    <List hasDividers ref={room.ref}>
      {runs.map((run) => {
        const outcome = runOutcome(run.status);
        const [glyph, color, action] = outcome
          ? [...OUTCOME[outcome], "Öppna"]
          : ([Clock, "accent", run.status === "awaiting_review" ? "Granska" : "Följ"] as const);
        const words = runWords(run, action);
        // A node, not a string: Astryx cuts a string label to one line, and a meeting's name may be long, or the
        // reader's text large; it wraps instead.
        const title = <>{words.title}</>;
        // The meeting's day and when it ran on one line, the state under them (Kaltron's rows): a state that wrapped onto a
        // line of its own would start it with the dot between them.
        const state = words.about ? (
          <>
            {words.about}
            <br />
            {runStatusLabel(run.status)}
          </>
        ) : (
          runStatusLabel(run.status)
        );
        // The name says which run, for a screen reader that lists the buttons, by its day and when too (a weekly
        // meeting repeats its name); the words say what it does.
        const open = (
          <Button label={words.which} variant="secondary" size="sm" data-open-run onClick={() => onOpen(run.id)}>
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
  );
}

/**
 * The setup's latest runs (`latestRuns`), at its top in the flow's column, so yesterday's meeting is one tap away before
 * the next one starts, and a run waiting for the person's review is first: Eneo cancels a review not done in time. Where
 * the list of earlier runs, at the working card's end, has more (`more`), "Visa alla" brings it into view and gives its
 * heading the focus.
 */
export function LatestRuns({
  runs,
  more,
  onOpen,
  className,
}: {
  runs: readonly FlowRunSummary[];
  more: boolean;
  onOpen: (runId: string) => void;
  className?: string;
}) {
  if (runs.length === 0) return null;
  const waiting = runs.filter((run) => run.status === "awaiting_review").length;
  const showAll = () => {
    const heading = document.getElementById("earlier-runs");
    heading?.scrollIntoView({ block: "start" });
    heading?.focus({ preventScroll: true });
  };
  return (
    <VStack as="section" aria-labelledby="latest-runs" gap={3} className={className}>
      <Heading level={2} id="latest-runs">
        Senaste körningar
      </Heading>
      {/* Why a run waiting first is to be reviewed now: Eneo cancels it otherwise. */}
      {waiting > 0 && (
        <Text as="p" type="supporting" color="secondary">
          {waiting === 1
            ? "En körning som väntar på granskning avbryts om den inte granskas i tid."
            : "Körningar som väntar på granskning avbryts om de inte granskas i tid."}
        </Text>
      )}
      <RunRows runs={runs} onOpen={onOpen} />
      {more && (
        <HStack>
          {/* Named for a screen reader that lists the buttons; under the heading the words are enough, and the arrow says
              the list is further down the page. */}
          <Button variant="ghost" icon={<Icon icon={ArrowDown} />} label="Visa alla körningar" onClick={showAll}>
            Visa alla
          </Button>
        </HStack>
      )}
    </VStack>
  );
}

/** This flow's earlier runs, so yesterday's document is one tap away, and more a page at a time. */
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
      <Heading level={2} id="earlier-runs" tabIndex={-1}>
        Tidigare körningar
      </Heading>
      <RunRows runs={shown} onOpen={onOpen} />
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
