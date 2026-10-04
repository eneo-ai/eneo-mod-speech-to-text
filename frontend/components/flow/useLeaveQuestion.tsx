"use client";

import { createContext, useEffect, useRef, useState } from "react";
import { useBlocker } from "react-router";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";

/**
 * Signing out, which is a request and not a navigation: the question comes before the session is ended, so it is the
 * page that asks and then goes on.
 */
export const LeaveContext = createContext<{ leaveFirst(goOn: () => void): void }>({
  leaveFirst: (goOn) => goOn(),
});

/**
 * While `active`, leaving the flow page asks first, in the page's own dialog. The router's blocker asks for every
 * departure it sees: a link, the brand, Back and Forward. A change of the address that keeps the page (the page writing
 * `?run=`) is no departure. The browser's own question (beforeunload, by the page) covers what no navigation reaches:
 * a reload, closing the tab, and Back from the first page of a visit.
 */
export function useLeaveQuestion(active: boolean, warning: string) {
  // Set by an answered sign-out question, so the way on to the start that follows it is not asked a second time.
  const allowed = useRef(false);
  useEffect(() => {
    allowed.current = false;
  }, [active]);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => active && !allowed.current && currentLocation.pathname !== nextLocation.pathname);
  const [signingOut, setSigningOut] = useState<(() => void) | null>(null);

  const stay = () => {
    setSigningOut(null);
    if (blocker.state === "blocked") blocker.reset();
  };
  const leave = () => {
    const goOn = signingOut;
    setSigningOut(null);
    if (blocker.state === "blocked") blocker.proceed();
    if (goOn) {
      allowed.current = true;
      goOn();
    }
  };

  // A native dialog: the browser keeps it above the covered page, and above the sign-in dialog when it was asked
  // while signed out, and the design system gives the focus back to what had it, which is the sign-in dialog then.
  // Staying has the focus: leaving stops a recording or a sending.
  const question = (
    <AlertDialog
      isOpen={blocker.state === "blocked" || signingOut !== null}
      onOpenChange={(open) => !open && stay()}
      title="Lämna sidan?"
      description={warning}
      cancelLabel="Stanna kvar"
      actionLabel="Lämna sidan"
      // Answered: the question closes with the answer, whether or not the way off the page then goes through.
      onAction={leave}
    />
  );
  /** Signing out: asked first, then `goOn`. */
  const leaveFirst = (goOn: () => void) => (active ? setSigningOut(() => goOn) : goOn());

  return { leaveFirst, question };
}
