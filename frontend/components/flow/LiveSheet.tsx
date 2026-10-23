import { Minimize2, Presentation } from "lucide-react";
import { memo, type RefObject, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import type { LiveSession } from "@/lib/flow-session";
import type { LivePiece } from "@/lib/live-transcriber";
import type { CaptureStatus } from "@/lib/recording-session";
import { atBottom, liveStatusLine } from "@/lib/recording-view";
import styles from "./LiveSheet.module.css";
import { useFullscreen, useSettledLiveStatus } from "./recording-hooks";

export function paragraphs(pieces: LivePiece[]): LivePiece[][] {
  const out: LivePiece[][] = [];
  for (const piece of pieces) {
    if (piece.opensParagraph || out.length === 0) out.push([piece]);
    else out[out.length - 1].push(piece);
  }
  return out;
}

const samePieces = (before: LivePiece[], after: LivePiece[]) => before.length === after.length && before.every((piece, i) => piece === after[i]);

// A paragraph's pieces render again only when one of them is another (a new one, or the relay's final text in place of a
// session's), not with every word still arriving.
const Pieces = memo(
  function Pieces({ pieces }: { pieces: LivePiece[] }) {
    return pieces.map((piece, i) => <span key={i}>{(i > 0 ? " " : "") + piece.text}</span>);
  },
  (before, after) => samePieces(before.pieces, after.pieces),
);

// A paragraph renders again only when its pieces or the words still arriving at its end change: a word renders the last
// paragraph, never the hours of them before it.
const Paragraph = memo(
  function Paragraph({ pieces, pending, forRoom }: { pieces: LivePiece[]; pending: string; forRoom: boolean }) {
    return (
      <Text as="p" {...(forRoom ? ({ type: "inherit" } as const) : ({ size: "lg" } as const))}>
        <Pieces pieces={pieces} />
        {pending && (
          <Text type="inherit" color="secondary" aria-hidden>
            {" " + pending.trim()}
          </Text>
        )}
      </Text>
    );
  },
  (before, after) => before.pending === after.pending && before.forRoom === after.forRoom && samePieces(before.pieces, after.pieces),
);

const TABLET = "(min-width: 768px)";

/**
 * Where "Visa i helskärm" is offered: from a tablet's width (on a phone its button would take a line of the text's
 * little room), in a browser that shows an element on the whole screen (an iPhone does not). The setup's line for
 * Strömma says so where it is.
 */
export function useRoomViewOffered(): boolean {
  const wide = useMediaQuery(TABLET, true);
  return wide && typeof document !== "undefined" && document.fullscreenEnabled === true;
}

/**
 * Strömma's workspace: the draft on a document sheet. Committed pieces form a
 * log a screen reader hears once each; words still arriving are shown faintly
 * and not read. The sheet follows new text only while the reader is at its
 * end, keeps its size as text arrives, and never moves focus into the text.
 *
 * "Visa i helskärm" puts `room` (the recording's section: this sheet and the bar with Pausa and Stoppa) alone on the
 * whole screen, for a projector or a screen on the wall: the text in a size read across a room, and what the sheet says
 * spoken to no one in particular. Esc or "Lämna helskärm" brings the page back, and the room view ends with the
 * recording.
 */
export function LiveSheet({
  live,
  recorder,
  speakers = false,
  room,
}: {
  live: LiveSession;
  recorder: CaptureStatus;
  /** The run labels speakers, which live text does not show: say they come with the final text. */
  speakers?: boolean;
  /** What "Visa i helskärm" shows on the whole screen. */
  room?: RefObject<HTMLElement | null>;
}) {
  const offered = useRoomViewOffered();
  // From a tablet's width the head stays over the text; on a phone it is the text's first line, and scrolls away with it
  // once the text fills the sheet, which follows the newest line.
  const pinned = useMediaQuery(TABLET, true);
  const snapshot = useSyncExternalStore(live.subscribe, live.getSnapshot, live.getSnapshot);
  const headingId = useId();
  const scroller = useRef<HTMLElement>(null);
  const [following, setFollowing] = useState(true);
  const noRoom = useRef<HTMLElement>(null);
  const fullscreen = useFullscreen(room ?? noRoom);
  const forRoom = fullscreen.active;
  const status = liveStatusLine(useSettledLiveStatus(snapshot.status), snapshot.started, recorder, forRoom);
  const groups = useMemo(() => paragraphs(snapshot.pieces), [snapshot.pieces]);
  const noText = groups.length === 0 && !snapshot.pending;
  // A failure replaces the placeholder; the persistent status region announces it once.
  const empty = noText && (status !== null || snapshot.status !== "unavailable");
  // On the presenter's page the text is the sheet's large body text; for a room it takes the room's size (the log's).
  const size = forRoom ? ({ type: "inherit" } as const) : ({ size: "lg" } as const);

  // After each change, and only while following: keep the newest line in view, also after the room view resizes it.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (following && element) element.scrollTop = element.scrollHeight;
  }, [snapshot.pieces, snapshot.pending, following, forRoom]);

  function showForRoom() {
    setFollowing(true);
    fullscreen.toggle();
  }

  function showLatest() {
    const element = scroller.current;
    if (!element) return;
    // Following again brings the newest line into view (the layout effect above), at once: a glide would be cut short
    // by it, and every line that arrives meanwhile moves the end it glides to.
    setFollowing(true);
    // The button goes away; the text it showed takes the focus.
    element.focus();
  }

  const head = (
      <HStack hAlign="between" vAlign="center" wrap="wrap" gap={2} className={styles.head}>
        <Heading level={2} color="secondary" weight="normal" id={headingId} data-phase-heading tabIndex={-1} className={styles.heading}>
          {forRoom ? (
            "Preliminär text, kan innehålla fel"
          ) : (
            // What the text is, as a pill, and when the final one comes, as the line beside it, or under it on a phone
            // (LiveSheet.module.css). Read as one sentence: "Preliminär text. …".
            <>
              <Token size="sm" label="Preliminär" className={styles.pill} />
              <VisuallyHidden> text.</VisuallyHidden>{" "}
              <span className={styles.when}>
                {speakers ? "Talare och den slutliga texten kommer när du är klar." : "Den slutliga texten skapas när du är klar."}
              </span>
            </>
          )}
        </Heading>
        {room && offered && (
          <Button
            variant="ghost"
            size="sm"
            icon={<Icon icon={forRoom ? Minimize2 : Presentation} />}
            label={forRoom ? "Lämna helskärm" : "Visa i helskärm"}
            onClick={showForRoom}
            className={styles.roomButton}
          />
        )}
      </HStack>
  );

  return (
    <Card padding={0} role="region" aria-labelledby={headingId} className={styles.sheet} data-room={forRoom || undefined}>
      {pinned && head}
      <div className={styles.logArea}>
        {/* The log is the scroll area: named, focusable for keyboard scrolling, heard once per piece. */}
        <StackItem
          size="fill"
          isScrollable
          ref={scroller}
          role="log"
          aria-label="Preliminär text"
          tabIndex={0}
          onScroll={(event) => setFollowing(atBottom(event.currentTarget))}
          className={styles.log}
        >
          {!pinned && head}
          {empty && (
            <Text as="p" color="secondary" {...size} aria-hidden={status ? true : undefined}>
              {status ?? (forRoom ? "Texten visas här när någon börjar prata." : "Texten visas här när du börjar prata.")}
            </Text>
          )}
          <VStack gap={4} maxWidth="68ch" className={styles.text}>
            {groups.map((group, index) => (
              <Paragraph key={index} pieces={group} pending={index === groups.length - 1 ? snapshot.pending : ""} forRoom={forRoom} />
            ))}
            {groups.length === 0 && snapshot.pending && (
              <Text as="p" {...size} color="secondary" aria-hidden>
                {snapshot.pending.trim()}
              </Text>
            )}
          </VStack>
        </StackItem>
        {!following && (
          <Button
            label="Visa senaste"
            variant="secondary"
            elevation="med"
            icon={<Icon icon="arrowDown" size="sm" />}
            onClick={showLatest}
            className={styles.latest}
          />
        )}
      </div>
      {/* Always rendered, so a change is said once; empty (and so no taller than nothing) while live text is fine. */}
      <Text as="p" type="supporting" role="status" className={status && !noText ? styles.statusLine : undefined}>
        {noText ? <VisuallyHidden>{status ?? ""}</VisuallyHidden> : status ?? ""}
      </Text>
      {/* A room sees the bar's Pausa only from afar: the pause is written where the text stopped. The page's own status
          says it to a screen reader, once. */}
      {forRoom && recorder === "paused" && (
        <Text as="p" type="supporting" aria-hidden className={styles.statusLine}>
          Inspelningen är pausad.
        </Text>
      )}
    </Card>
  );
}
