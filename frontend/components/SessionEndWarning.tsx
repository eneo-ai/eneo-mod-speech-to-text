"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/** Where the login window says it has signed in again; every tab of the module listens. */
export const SESSION_CHANNEL = "tal-till-text:session";

// Long enough to finish what one is doing (WCAG 2.2.1 asks for at least 20 seconds).
const WARN_BEFORE_MS = 5 * 60_000;

/**
 * The login ends at a fixed time, Eneo's session ceiling, which only a new
 * login can move. Five minutes before, a dialog says so; with Eneo SSO,
 * "Fortsätt arbeta" signs in again in a window of its own, so nothing on
 * this page is left or lost (WCAG 2.2.1, extend).
 */
export function SessionEndWarning({ endsAt, canRenew }: { endsAt: number | null; canRenew: boolean }) {
  const [open, setOpen] = useState(false);
  const [blocked, setBlocked] = useState(false);
  // The dialog has no button of its own on the page: focus goes back to where it was.
  const returnFocus = useRef<HTMLElement | null>(null);

  // A later end (a renewed login) takes the warning away and sets it again for the new end.
  useEffect(() => {
    setOpen(false);
    setBlocked(false);
    if (endsAt === null) return;
    const timer = setTimeout(() => {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen(true);
    }, Math.max(0, endsAt - WARN_BEFORE_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [endsAt]);

  function renew() {
    const login = window.open("/api/auth/login?next=%2Finloggad", "tal-till-text-inloggning", "popup,width=520,height=700");
    setBlocked(login === null);
  }

  const time = endsAt === null ? "" : new Date(endsAt).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Du loggas snart ut</AlertDialogTitle>
          <AlertDialogDescription>
            Inloggningen upphör kl. {time}.{" "}
            {canRenew
              ? "Fortsätt arbeta loggar in dig igen i ett nytt fönster. Allt på den här sidan finns kvar."
              : "Spara det du arbetar med innan dess."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {blocked && (
          <p role="alert" className="text-sm text-destructive">
            Fönstret kunde inte öppnas. Tillåt popup-fönster för Tal till text och försök igen.
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel className="h-11">Stäng</AlertDialogCancel>
          {canRenew && (
            <Button type="button" className="h-11" onClick={renew}>
              Fortsätt arbeta
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
