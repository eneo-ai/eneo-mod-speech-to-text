"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type MouseEvent } from "react";
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
import { guardHistory } from "@/lib/leave-guard";

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

  const question = (
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
        <AlertDialogFooter>
          <AlertDialogCancel>Stanna kvar</AlertDialogCancel>
          <AlertDialogAction onClick={() => leave?.()}>Lämna sidan</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { onLeave, question };
}
