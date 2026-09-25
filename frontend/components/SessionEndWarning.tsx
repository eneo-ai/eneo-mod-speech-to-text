"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, loginWithAccessCode, type AuthMode, type AuthenticatedUser } from "@/lib/api";
import { userDisplayName } from "@/lib/user-identity";

/** Where the login window says it has signed in again; every tab of the module listens. */
export const SESSION_CHANNEL = "tal-till-text:session";

// Long enough to finish what one is doing (WCAG 2.2.1 asks for at least 20 seconds).
const WARN_BEFORE_MS = 5 * 60_000;

/**
 * The login ends at a fixed time, which only a new login can move. Five
 * minutes before, a dialog says so and offers that new login without leaving
 * the page, so nothing on it is lost (WCAG 2.2.1, extend): with Eneo SSO in a
 * window of its own, with the access code by entering it here. Once it has
 * ended (`signedOut`) the same dialog stays open until that new login, over a
 * page that keeps everything, a recording included.
 */
export function SessionEndWarning({
  endsAt,
  mode,
  signedOut = false,
  owner = null,
  otherUser = null,
  controlsRef,
  onFocusBack,
  onRenewed,
}: {
  endsAt: number | null;
  mode: AuthMode | null;
  /** The login has ended: nothing on the page is within reach until the new login. */
  signedOut?: boolean;
  /** The page's user, the one to sign in as. */
  owner?: AuthenticatedUser | null;
  /** Someone else signed in instead: the page stays covered until its own user does. */
  otherUser?: AuthenticatedUser | null;
  /** Signed out, the place where the page puts a recording's Pausa and Stoppa, which need no login. */
  controlsRef?: (element: HTMLElement | null) => void;
  /** The access code signed in again: read the new end. */
  onRenewed: () => void;
  /** After the dialog that covered an ended login has closed: the page gives the focus back, `before` the warning. */
  onFocusBack?: (before: HTMLElement | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const codeId = useId();
  const problemId = useId();
  // The dialog has no button of its own on the page: focus goes back to where it was.
  const returnFocus = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);

  // A later end (a renewed login) takes the warning away and sets it again for the new end.
  useEffect(() => {
    setOpen(false);
    setProblem(null);
    setCode("");
    if (endsAt === null) return;
    const timer = setTimeout(() => {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen(true);
    }, Math.max(0, endsAt - WARN_BEFORE_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [endsAt]);

  function renewInWindow() {
    // Before the end, `renew` binds the new login to the user signed in now. After it the backend has nobody to
    // bind to and refuses a renewal: a new login instead, and AuthGate unlocks the page only for its own user.
    const url = signedOut ? "/api/auth/login?next=%2Finloggad" : "/api/auth/login?renew=1&next=%2Finloggad";
    const login = window.open(url, "tal-till-text-inloggning", "popup,width=520,height=700");
    setProblem(login === null ? "Fönstret kunde inte öppnas. Tillåt popup-fönster för Tal till text och försök igen." : null);
  }

  async function renewWithCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setProblem(null);
    try {
      // A new access-code login is a new session with a full lifetime.
      await loginWithAccessCode(code);
      onRenewed();
    } catch (error) {
      setProblem(
        error instanceof ApiError && error.status === 401
          ? "Felaktig åtkomstkod."
          : "Inloggningen kunde inte förnyas. Försök igen.",
      );
    } finally {
      setSending(false);
    }
  }

  const time = endsAt === null ? "" : new Date(endsAt).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  const byCode = mode === "access_code";
  // This dialog covered an ended login until it has closed, however it was opened: its words stay, and the
  // focus goes back through the page (onFocusBack) once it is closed, not before.
  const coveredEnd = useRef(false);
  if (signedOut) coveredEnd.current = true;
  const ended = coveredEnd.current;
  // Who signed in instead, kept while the dialog closes.
  const [other, setOther] = useState(otherUser);
  if (signedOut && other?.id !== otherUser?.id) setOther(otherUser);
  const action = ended ? "Logga in igen" : "Fortsätt arbeta";
  // Signed out, nothing but the new login closes it.
  return (
    <AlertDialog open={open || signedOut} onOpenChange={setOpen}>
      <AlertDialogContent
        // The login ended: the page under the focus is covered, so the focus moves into the dialog, onto its heading,
        // and a screen reader says it (WCAG 2.4.3). The warning keeps Stäng as its first stop.
        onOpenAutoFocus={(event) => {
          if (!signedOut) return;
          event.preventDefault();
          heading.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const before = returnFocus.current;
          returnFocus.current = null;
          if (!coveredEnd.current) return before?.focus();
          coveredEnd.current = false;
          onFocusBack?.(before);
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle ref={heading} tabIndex={-1} className="outline-none">
            {ended ? "Du behöver logga in igen" : "Du loggas snart ut"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {other && owner
              ? `Du är inloggad som ${userDisplayName(other)}. Logga in som ${userDisplayName(owner)} för att fortsätta. `
              : ended
                ? "Inloggningen har upphört. "
                : `Inloggningen upphör kl. ${time}. `}
            {byCode
              ? `Ange åtkomstkoden och välj ${action} för att fortsätta.`
              : `${action} loggar in dig igen i ett nytt fönster.`}{" "}
            {ended
              ? "Allt på den här sidan finns kvar, och en inspelning fortsätter och sparas på enheten."
              : "Allt på den här sidan finns kvar."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {signedOut && <div ref={controlsRef} />}
        {byCode && (
          <form id={`${codeId}-form`} className="flex flex-col gap-2" onSubmit={(event) => void renewWithCode(event)}>
            <Label htmlFor={codeId}>Åtkomstkod</Label>
            <Input
              id={codeId}
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? problemId : undefined}
            />
          </form>
        )}
        {problem && (
          <p id={problemId} role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        <AlertDialogFooter>
          {!ended && <AlertDialogCancel className="h-11">Stäng</AlertDialogCancel>}
          {byCode ? (
            <Button type="submit" form={`${codeId}-form`} className="h-11" disabled={sending}>
              {action}
            </Button>
          ) : (
            <Button type="button" className="h-11" onClick={renewInWindow}>
              {action}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
