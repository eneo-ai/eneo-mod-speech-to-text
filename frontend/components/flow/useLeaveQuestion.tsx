"use client";

import { createContext, useEffect, useRef, useState, type MouseEvent } from "react";
import { useNavigate } from "react-router";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { guardHistory } from "@/lib/leave-guard";

/** The page's leave question for the exits in its top bar: the links, and signing out. */
export const LeaveContext = createContext<{ onLeave(event: MouseEvent): void; leaveFirst(goOn: () => void): void }>({
  onLeave: () => undefined,
  leaveFirst: (goOn) => goOn(),
});

/**
 * While `active`, leaving the flow page asks first, in the page's own dialog: browser back through the history
 * guard, and the page's links through `onLeave`. beforeunload keeps the browser's.
 */
export function useLeaveQuestion(active: boolean, warning: string) {
  const navigate = useNavigate();
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const ask = (goOn: () => void) => setLeave(() => goOn);
  const attempt = useRef(ask);
  attempt.current = ask;
  useEffect(() => {
    if (!active) return;
    return guardHistory(window, (goOn) => attempt.current(goOn));
  }, [active]);

  const onLeave = (event: MouseEvent) => {
    if (!active) return;
    event.preventDefault();
    ask(() => void navigate("/flows"));
  };

  // A native dialog: the browser keeps it above the covered page, and above the sign-in dialog when it was asked
  // while signed out, and the design system gives the focus back to what had it, which is the sign-in dialog then.
  // Staying has the focus: leaving stops a recording or a sending.
  const question = (
    <AlertDialog
      isOpen={leave !== null}
      onOpenChange={(open) => !open && setLeave(null)}
      title="Lämna sidan?"
      description={warning}
      cancelLabel="Stanna kvar"
      actionLabel="Lämna sidan"
      // Answered: the question is closed first, whether or not the way off the page then goes through.
      onAction={() => {
        const goOn = leave;
        setLeave(null);
        goOn?.();
      }}
    />
  );
  /** Any other way off the page (signing out): asked first, then `goOn`. */
  const leaveFirst = (goOn: () => void) => (active ? ask(goOn) : goOn());

  return { onLeave, leaveFirst, question };
}
