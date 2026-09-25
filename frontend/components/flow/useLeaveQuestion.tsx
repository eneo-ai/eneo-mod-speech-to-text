"use client";

import { useRouter } from "next/navigation";
import { createContext, useEffect, useRef, useState, type MouseEvent } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PortalContainer } from "@/components/ui/portal-container";
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
  const router = useRouter();
  const [leave, setLeave] = useState<(() => void) | null>(null);
  // The question has no trigger of its own: focus goes back to where it was.
  const returnFocus = useRef<HTMLElement | null>(null);
  const ask = (goOn: () => void) => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setLeave(() => goOn);
  };
  const attempt = useRef(ask);
  attempt.current = ask;
  useEffect(() => {
    if (!active) return;
    return guardHistory(window, (goOn) => attempt.current(goOn));
  }, [active]);

  const onLeave = (event: MouseEvent) => {
    if (!active) return;
    event.preventDefault();
    ask(() => router.push("/flows"));
  };

  // Outside the covered page while signed out, like the sign-in dialog: the question holds nothing of the page's.
  const question = (
    <PortalContainer.Provider value={null}>
      <AlertDialog open={leave !== null} onOpenChange={(open) => !open && setLeave(null)}>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Lämna sidan?</AlertDialogTitle>
            <AlertDialogDescription>{warning}</AlertDialogDescription>
          </AlertDialogHeader>
          {/* Staying is the filled action: leaving stops a recording or a sending. */}
          <AlertDialogFooter>
            <AlertDialogCancel className={cn(buttonVariants(), "border-transparent hover:text-primary-foreground")}>Stanna kvar</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: "outline" })} onClick={() => leave?.()}>
              Lämna sidan
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PortalContainer.Provider>
  );
  /** Any other way off the page (signing out): asked first, then `goOn`. */
  const leaveFirst = (goOn: () => void) => (active ? ask(goOn) : goOn());

  return { onLeave, leaveFirst, question };
}
