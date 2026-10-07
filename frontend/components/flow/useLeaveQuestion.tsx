import { createContext, useCallback, useEffect, useRef, useState } from "react";
import { useBlocker } from "react-router";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";

/**
 * Actions that replace the view or end the session ask before they discard unsaved work, even without navigation.
 */
export const LeaveContext = createContext<{
  leaveFirst(goOn: () => void | Promise<void>): void;
  holdUnsavedCorrections(): () => void;
}>({
  leaveFirst: (goOn) => void goOn(),
  holdUnsavedCorrections: () => () => undefined,
});

const CORRECTIONS_LEAVE = "Du har rättningar som inte har sparats. De försvinner om du lämnar sidan.";

/**
 * While `active`, leaving the flow page asks first, in the page's own dialog. The router's blocker asks for every
 * departure it sees: a link, the brand, Back and Forward. A change of the address that keeps the page (the page writing
 * `?run=`) is no departure. The browser's own question (beforeunload, by the page) covers what no navigation reaches:
 * a reload, closing the tab, and Back from the first page of a visit.
 */
export function useLeaveQuestion(active: boolean, warning: string, keepsWork = false) {
  const [correctionsHeld, setCorrectionsHeld] = useState(0);
  const holdUnsavedCorrections = useCallback(() => {
    setCorrectionsHeld((count) => count + 1);
    return () => setCorrectionsHeld((count) => count - 1);
  }, []);
  const unsavedCorrections = correctionsHeld > 0;
  const guarded = active || unsavedCorrections;
  // A confirmed action may navigate too. Allow that navigation once, and reset if the action does not leave.
  const allowed = useRef(false);
  useEffect(() => {
    allowed.current = false;
  }, [guarded]);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => guarded && !allowed.current && currentLocation.pathname !== nextLocation.pathname);
  const [pendingAction, setPendingAction] = useState<(() => void | Promise<void>) | null>(null);

  const stay = () => {
    setPendingAction(null);
    if (blocker.state === "blocked") blocker.reset();
  };
  const leave = () => {
    const goOn = pendingAction;
    setPendingAction(null);
    if (blocker.state === "blocked") blocker.proceed();
    if (goOn) {
      allowed.current = true;
      void (async () => {
        try {
          await goOn();
        } finally {
          allowed.current = false;
        }
      })();
    }
  };

  // A native dialog: the browser keeps it above the covered page, and above the sign-in dialog when it was asked
  // while signed out, and the design system gives the focus back to what had it, which is the sign-in dialog then.
  // Staying has the focus: leaving stops a recording or a sending.
  const question = (
    <AlertDialog
      isOpen={blocker.state === "blocked" || pendingAction !== null}
      onOpenChange={(open) => !open && stay()}
      title="Lämna sidan?"
      description={unsavedCorrections ? `${active ? `${warning} ` : ""}${CORRECTIONS_LEAVE}` : warning}
      cancelLabel="Stanna kvar"
      actionLabel="Lämna sidan"
      // Red only where leaving loses something (lib/recording-view leaveKeepsWork).
      actionVariant={keepsWork && !unsavedCorrections ? "secondary" : "destructive"}
      // Answered: the question closes with the answer, whether or not the way off the page then goes through.
      onAction={leave}
    />
  );
  const leaveFirst = (goOn: () => void | Promise<void>) => (guarded ? setPendingAction(() => goOn) : void goOn());

  return { leaveFirst, holdUnsavedCorrections, question };
}
