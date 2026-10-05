"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack, Layout, LayoutContent, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import styles from "@/components/SessionEndWarning.module.css";
import type { AuthenticatedUser } from "@/lib/api";
import { userDisplayName } from "@/lib/user-identity";

/** Where the login window says it has signed in again; every tab of the module listens. */
export const SESSION_CHANNEL = "tal-till-text:session";

// Long enough to finish what one is doing (WCAG 2.2.1 asks for at least 20 seconds).
const WARN_BEFORE_MS = 5 * 60_000;
// The longest delay a timer holds: a longer one (a login set to last more than 24.8 days) fires at once.
const LONGEST_TIMER_MS = 2 ** 31 - 1;

/**
 * The login ends at a fixed time, which only a new login can move. Five
 * minutes before, a dialog says so and offers that new login without leaving
 * the page, so nothing on it is lost (WCAG 2.2.1, extend): Eneo's login, in a
 * window of its own. Once it has ended (`signedOut`) the same dialog stays open until that new login, over a
 * page that keeps everything, a recording included.
 */
export function SessionEndWarning({
  endsAt,
  signedOut = false,
  owner = null,
  otherUser = null,
  controlsRef,
  onFocusBack,
}: {
  endsAt: number | null;
  /** The login has ended: nothing on the page is within reach until the new login. */
  signedOut?: boolean;
  /** The page's user, the one to sign in as. */
  owner?: AuthenticatedUser | null;
  /** Someone else signed in instead: the page stays covered until its own user does. */
  otherUser?: AuthenticatedUser | null;
  /** Signed out, the place where the page puts a recording's Pausa and Stoppa, which need no login. */
  controlsRef?: (element: HTMLElement | null) => void;
  /** After the dialog that covered an ended login has closed: the page gives the focus back, `before` the warning. */
  onFocusBack?: (before: HTMLElement | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Where the focus was when the warning opened: the page's, once the dialog has covered an ended login.
  const returnFocus = useRef<HTMLElement | null>(null);

  // A later end (a renewed login) takes the warning away and sets it again for the new end.
  useEffect(() => {
    setOpen(false);
    setProblem(null);
    if (endsAt === null) return;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      const wait = Math.max(0, endsAt - WARN_BEFORE_MS - Date.now());
      timer = setTimeout(
        wait > LONGEST_TIMER_MS
          ? arm
          : () => {
              returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
              setOpen(true);
            },
        Math.min(wait, LONGEST_TIMER_MS),
      );
    };
    arm();
    return () => clearTimeout(timer);
  }, [endsAt]);

  function renewInWindow() {
    // Before the end, `renew` binds the new login to the user signed in now. After it the backend has nobody to
    // bind to and refuses a renewal: a new login instead, and AuthGate unlocks the page only for its own user.
    const url = signedOut ? "/api/auth/login?next=%2Finloggad" : "/api/auth/login?renew=1&next=%2Finloggad";
    const login = window.open(url, "tal-till-text-inloggning", "popup,width=520,height=700");
    setProblem(login === null ? "Fönstret kunde inte öppnas. Tillåt popup-fönster för Tal till text och försök igen." : null);
  }

  const time = endsAt === null ? "" : new Date(endsAt).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  // This dialog covered an ended login until it has closed, however it was opened: its words stay, and the
  // focus goes back through the page (onFocusBack) once it is closed, not before.
  const coveredEnd = useRef(false);
  if (signedOut) coveredEnd.current = true;
  const ended = coveredEnd.current;
  // Who signed in instead, kept while the dialog closes.
  const [other, setOther] = useState(otherUser);
  if (signedOut && other?.id !== otherUser?.id) setOther(otherUser);
  const action = ended ? "Logga in igen" : "Fortsätt arbeta";
  const shown = open || signedOut;

  const focusTitle = () => {
    const title = dialogRef.current?.getAttribute("aria-labelledby");
    if (title) document.getElementById(title)?.focus();
  };
  // The title names the dialog, and has the focus when it opens and when the login ends under an open warning (WCAG
  // 2.4.3), so that a screen reader says it. Chromium and WebKit take it first; Firefox takes the first button.
  useEffect(() => {
    if (shown) focusTitle();
  }, [shown, ended]);

  // Signed out, the page is behind a modal. A second close request without a new user action (Android's back is one)
  // cannot be kept from closing a native dialog, and the design system goes on showing it: an open box that is no
  // modal. It is opened as a modal again, until the new login takes the listener away and the dialog with it.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !signedOut) return;
    const reopen = () => {
      if (!dialog.isConnected || dialog.open) return;
      dialog.showModal();
      focusTitle();
    };
    dialog.addEventListener("close", reopen);
    return () => dialog.removeEventListener("close", reopen);
  }, [signedOut, shown]);

  // Closed, the warning gives the focus back to what had it. An ended login is different: the page under the dialog
  // was covered and may have changed, so after the new login the page decides where the focus goes.
  const wasShown = useRef(false);
  useEffect(() => {
    if (wasShown.current && !shown) {
      const before = returnFocus.current;
      returnFocus.current = null;
      if (!coveredEnd.current) before?.focus();
      else {
        coveredEnd.current = false;
        onFocusBack?.(before);
      }
    }
    wasShown.current = shown;
  }, [shown, onFocusBack]);

  // In the tree only while it is shown: a modal dialog of the page that is open when it appears has hidden what was
  // in the document by then from assistive technology (aria-hidden), and a dialog that was already there with it.
  // Signed out, nothing but the new login closes it, and nothing of the page shows through (the stylesheet).
  if (!shown) return null;
  return (
    <Dialog
      ref={dialogRef}
      isOpen={shown}
      onOpenChange={setOpen}
      role="alertdialog"
      // Like the alert dialog it replaces, the warning does not close on a click beside it: it is the only notice.
      purpose={signedOut ? "required" : "form"}
      aria-describedby={descriptionId}
      // The whole height of the screen but its gutters, as the width has: a short screen shows as much as it can.
      maxHeight="calc(100dvh - 2 * var(--spacing-4))"
      className={signedOut ? styles.signedOut : undefined}
    >
      {/* One region holds the title, the words and the action, so that what does not fit a short screen scrolls as a whole. */}
      <Layout
        content={
          <LayoutContent padding={0}>
            <DialogHeader title={ended ? "Du behöver logga in igen" : "Du loggas snart ut"} onOpenChange={ended ? undefined : setOpen} hasDivider={false} />
            {/* The room under the last control is for its focus ring, which the scroller would clip. */}
            <VStack gap={4} paddingInline={4} paddingBlockEnd={4}>
              <Text as="p" display="block" color="secondary" id={descriptionId}>
                {other && owner
                  ? `Du är inloggad som ${userDisplayName(other)}. Logga in som ${userDisplayName(owner)} för att fortsätta. `
                  : ended
                    ? "Inloggningen har upphört. "
                    : `Inloggningen upphör kl. ${time}. `}
                {`${action} loggar in dig igen i ett nytt fönster.`}{" "}
                {ended
                  ? "Allt på den här sidan finns kvar, och en inspelning fortsätter och sparas på enheten."
                  : "Allt på den här sidan finns kvar."}
              </Text>
              {signedOut && <div ref={controlsRef} />}
              {problem && <Banner status="error" title={problem} collapsible={false} />}
              <HStack gap={2} hAlign="end">
                <Button label={action} variant="primary" size="lg" onClick={renewInWindow} />
              </HStack>
            </VStack>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}
