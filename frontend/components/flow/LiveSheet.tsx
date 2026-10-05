import { memo, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { LiveSession } from "@/lib/flow-session";
import type { LivePiece } from "@/lib/live-transcriber";
import type { CaptureStatus } from "@/lib/recording-session";
import { atBottom, liveStatusLine } from "@/lib/recording-view";
import styles from "./LiveSheet.module.css";

export function paragraphs(pieces: LivePiece[]): LivePiece[][] {
  const out: LivePiece[][] = [];
  for (const piece of pieces) {
    if (piece.opensParagraph || out.length === 0) out.push([piece]);
    else out[out.length - 1].push(piece);
  }
  return out;
}

// A paragraph renders again only when one of its pieces is another (a new one, or the relay's final text in place of a
// session's), not with every word still arriving.
const Pieces = memo(
  function Pieces({ pieces }: { pieces: LivePiece[] }) {
    return pieces.map((piece, i) => <span key={i}>{(i > 0 ? " " : "") + piece.text}</span>);
  },
  (before, after) => before.pieces.length === after.pieces.length && before.pieces.every((piece, i) => piece === after.pieces[i]),
);

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Strömma's workspace: the draft on a document sheet. Committed pieces form a
 * log a screen reader hears once each; words still arriving are shown faintly
 * and not read. The sheet follows new text only while the reader is at its
 * end, keeps its size as text arrives, and never moves focus into the text.
 */
export function LiveSheet({
  live,
  recorder,
  speakers = false,
}: {
  live: LiveSession;
  recorder: CaptureStatus;
  /** The run labels speakers, which live text does not show: say they come with the final text. */
  speakers?: boolean;
}) {
  const snapshot = useSyncExternalStore(live.subscribe, live.getSnapshot, live.getSnapshot);
  const headingId = useId();
  const scroller = useRef<HTMLElement>(null);
  const [following, setFollowing] = useState(true);
  const status = liveStatusLine(snapshot.status, snapshot.started, recorder);
  const groups = paragraphs(snapshot.pieces);
  // No promise of text once live text could not start; the status line says why.
  const empty = groups.length === 0 && !snapshot.pending && snapshot.status !== "unavailable";

  // After each change, and only while following: keep the newest line in view.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (following && element) element.scrollTop = element.scrollHeight;
  }, [snapshot.pieces, snapshot.pending, following]);

  function showLatest() {
    const element = scroller.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    setFollowing(true);
    // The button goes away; the text it showed takes the focus.
    element.focus();
  }

  return (
    <Card padding={0} role="region" aria-labelledby={headingId} className={styles.sheet}>
      <Heading level={2} color="secondary" weight="normal" id={headingId} data-phase-heading tabIndex={-1} className={styles.heading}>
        {speakers
          ? "Preliminär text. Talare och den slutliga texten kommer när du är klar."
          : "Preliminär text, den slutliga skapas när du är klar"}
      </Heading>
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
        {empty && (
          <Text as="p" color="secondary" size="lg">
            Texten visas här när du börjar prata.
          </Text>
        )}
        <VStack gap={4} maxWidth="68ch" className={styles.text}>
          {groups.map((group, index) => (
            <Text as="p" size="lg" key={index}>
              <Pieces pieces={group} />
              {index === groups.length - 1 && snapshot.pending && (
                <Text type="inherit" color="secondary" aria-hidden>
                  {" " + snapshot.pending.trim()}
                </Text>
              )}
            </Text>
          ))}
          {groups.length === 0 && snapshot.pending && (
            <Text as="p" size="lg" color="secondary" aria-hidden>
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
      {/* Always rendered, so a change is said once; empty (and so no taller than nothing) while live text is fine. */}
      <Text as="p" type="supporting" role="status" className={status ? styles.statusLine : undefined}>
        {status ?? ""}
      </Text>
    </Card>
  );
}
