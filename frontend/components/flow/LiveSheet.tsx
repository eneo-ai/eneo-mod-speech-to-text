"use client";

import { ArrowDown } from "lucide-react";
import { memo, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import type { LiveSession } from "@/lib/flow-session";
import type { LivePiece } from "@/lib/live-transcriber";
import type { CaptureStatus } from "@/lib/recording-session";
import { atBottom, liveStatusLine } from "@/lib/recording-view";

function paragraphs(pieces: LivePiece[]): LivePiece[][] {
  const out: LivePiece[][] = [];
  for (const piece of pieces) {
    if (piece.opensParagraph || out.length === 0) out.push([piece]);
    else out[out.length - 1].push(piece);
  }
  return out;
}

// Committed text only grows at its end, so over a long meeting a paragraph
// renders again only when it gains a piece, not with every word.
const Pieces = memo(
  function Pieces({ pieces }: { pieces: LivePiece[] }) {
    return pieces.map((piece, i) => <span key={i}>{(i > 0 ? " " : "") + piece.text}</span>);
  },
  (before, after) => before.pieces.length === after.pieces.length && before.pieces[0] === after.pieces[0],
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
export function LiveSheet({ live, recorder }: { live: LiveSession; recorder: CaptureStatus }) {
  const snapshot = useSyncExternalStore(live.subscribe, live.getSnapshot, live.getSnapshot);
  const headingId = useId();
  const scroller = useRef<HTMLDivElement>(null);
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
    <section
      aria-labelledby={headingId}
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card"
    >
      <h2 id={headingId} data-phase-heading tabIndex={-1} className="px-5 pt-4 text-[13px] text-muted-foreground outline-none md:px-7">
        Preliminär text, den slutliga skapas när du är klar
      </h2>
      {/* The log is the scroll area: named, focusable for keyboard scrolling, heard once per piece. */}
      <div
        ref={scroller}
        role="log"
        aria-label="Preliminär text"
        tabIndex={0}
        onScroll={(event) => setFollowing(atBottom(event.currentTarget))}
        className="min-h-0 flex-1 overflow-y-auto px-5 pb-8 pt-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:px-7"
      >
        {empty && <p className="text-[17px] text-muted-foreground">Texten visas här när du börjar prata.</p>}
        <div className="flex max-w-[68ch] flex-col gap-4 text-[18px] leading-[1.6] text-foreground md:text-[19px]">
          {groups.map((group, index) => (
            <p key={index}>
              <Pieces pieces={group} />
              {index === groups.length - 1 && snapshot.pending && (
                <span aria-hidden className="text-muted-foreground">
                  {" " + snapshot.pending.trim()}
                </span>
              )}
            </p>
          ))}
          {groups.length === 0 && snapshot.pending && (
            <p aria-hidden className="text-muted-foreground">
              {snapshot.pending.trim()}
            </p>
          )}
        </div>
      </div>
      {!following && (
        <Button
          type="button"
          variant="outline"
          className="absolute bottom-16 left-1/2 -translate-x-1/2 rounded-full bg-card shadow-md"
          onClick={showLatest}
        >
          <ArrowDown data-icon="inline-start" aria-hidden />
          Visa senaste
        </Button>
      )}
      {/* Always rendered, so a change is said once; empty while live text is fine. */}
      <p role="status" className={status ? "border-t border-border px-5 py-3 text-[14px] text-ink-soft md:px-7" : "sr-only"}>
        {status ?? ""}
      </p>
    </section>
  );
}
