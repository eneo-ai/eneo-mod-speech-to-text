"use client";

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { SESSION_CHANNEL, SessionEndWarning } from "@/components/SessionEndWarning";
import { PortalContainer } from "@/components/ui/portal-container";
import { Spinner } from "@/components/ui/spinner";
import { authStatus, type AuthMode, type AuthStatus, type AuthenticatedUser } from "@/lib/api";
import { browserDrafts, keepOnlyDraftsOf } from "@/lib/drafts";
import { loginState } from "@/lib/login-state";
import { keepSessionAlive } from "@/lib/session-keepalive";
import { sessionUser } from "@/lib/user-identity";

// Exported for component tests; pages get the user through AuthGate.
export const AuthenticatedUserContext = createContext<AuthenticatedUser | null>(null);

/** While the page is covered for a new login: the place in the sign-in dialog for its recording controls. */
export const SignedOutSlot = createContext<HTMLElement | null>(null);

export function useAuthenticatedUser(): AuthenticatedUser {
  const user = useContext(AuthenticatedUserContext);
  if (!user) {
    throw new Error("useAuthenticatedUser must be used inside AuthGate");
  }
  return user;
}

/**
 * While the login has ended the page stays mounted, so nothing on it is lost and a recording goes on, but it is
 * neither shown nor within reach until the new login.
 */
export function SignedOutCover({ signedOut, children }: { signedOut: boolean; children: React.ReactNode }) {
  // The page's overlays open in here too, so a dialog with names or quotes is covered with the page.
  const [container, setContainer] = useState<HTMLElement | null>(null);
  // Where on the page the focus was when the login ended, taken before the cover's inert moves it away.
  const lost = useRef<{ from: HTMLElement | null } | null>(null);
  useEffect(
    () =>
      loginState.subscribe(() => {
        if (!loginState.signedOut || lost.current) return;
        const active = document.activeElement;
        lost.current = { from: active instanceof HTMLElement && container?.contains(active) ? active : null };
      }),
    [container],
  );
  // Back once the page's own user is: there, or on the page's heading when it is gone or was elsewhere.
  useEffect(() => {
    if (signedOut || !lost.current) return;
    const { from } = lost.current;
    lost.current = null;
    (from?.isConnected ? from : container?.querySelector<HTMLElement>("[data-phase-heading], h1[tabindex]"))?.focus();
  }, [signedOut, container]);
  return (
    <div ref={setContainer} className={signedOut ? "contents invisible" : "contents"} inert={signedOut}>
      <PortalContainer.Provider value={container}>{children}</PortalContainer.Provider>
    </div>
  );
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  // When the login ends, and how a new login moves that.
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [mode, setMode] = useState<AuthMode | null>(null);
  const recheckRef = useRef(() => {});
  const signedOut = useSyncExternalStore(loginState.subscribe, () => loginState.signedOut, () => false);
  const otherUser = useSyncExternalStore(loginState.subscribe, () => loginState.otherUser, () => null);
  const [controls, setControls] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let stopKeepalive: (() => void) | undefined;
    let channel: BroadcastChannel | null = null;

    let endPage: (() => void) | undefined;
    const observe = (s: AuthStatus) => {
      // Signed in, until when, or signed out: the page asks for a new login in place, never navigates.
      loginState.observe(s);
      if (s.authenticated && s.session_ends_in !== undefined) {
        const next = Date.now() + s.session_ends_in * 1000;
        // The same end read again moves by the request's second or so; only a new login moves it far.
        setEndsAt((current) => (current !== null && Math.abs(next - current) < 60_000 ? current : next));
        setMode(s.auth_mode);
      }
    };
    // Answers can come back out of order (a slow check, then a renewal's): only an answer to a later question
    // than the last one used moves the end or the keepalive. A stopped keepalive's answers count the same way.
    let asked = 0;
    let used = 0;
    const read = async (): Promise<AuthStatus | null> => {
      const question = ++asked;
      const s = await authStatus();
      if (cancelled || question <= used) return null;
      used = question;
      observe(s);
      return s;
    };
    // The token keepalive follows the latest status: a renewed login brings a token of its own to refresh,
    // after the old one's keepalive stopped at the old end.
    const keepAlive = (s: AuthStatus) => {
      stopKeepalive?.();
      stopKeepalive = keepSessionAlive(s, read);
    };
    const recheck = () =>
      void read().then(
        (s) => s && keepAlive(s),
        () => undefined,
      );
    recheckRef.current = recheck;
    const onVisible = () => document.visibilityState === "visible" && recheck();

    read()
      .then((s) => {
        if (!s) return;
        // I access_code-läget saknar sessionen användare; sessionUser ger då
        // en platshållare så vi inte studsar tillbaka till loginsidan i en loop.
        const sessionIdentity = sessionUser(s);
        if (!sessionIdentity) {
          router.replace("/");
          return;
        }
        setUser(sessionIdentity);
        // Someone else's unsent details and edits are not this person's to see.
        keepOnlyDraftsOf(browserDrafts(), sessionIdentity.id);
        endPage = loginState.begin(sessionIdentity);
        keepAlive(s);
        // From here a login renewed in its own window (or another tab) moves the end for this page too.
        channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(SESSION_CHANNEL);
        channel?.addEventListener("message", recheck);
        document.addEventListener("visibilitychange", onVisible);
      })
      .catch(() => {
        if (!cancelled) router.replace("/");
      });

    return () => {
      cancelled = true;
      endPage?.();
      stopKeepalive?.();
      channel?.close();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);

  if (!user) {
    return (
      <main className="min-h-screen grid place-items-center">
        <h1 className="sr-only">Tal till text</h1>
        <Spinner className="size-5 text-ink-mute" />
      </main>
    );
  }

  return (
    <AuthenticatedUserContext.Provider value={user}>
      <SignedOutSlot.Provider value={controls}>
        <SignedOutCover signedOut={signedOut}>{children}</SignedOutCover>
      </SignedOutSlot.Provider>
      <SessionEndWarning
        endsAt={endsAt}
        mode={mode}
        signedOut={signedOut}
        owner={user}
        otherUser={otherUser}
        controlsRef={setControls}
        onRenewed={() => recheckRef.current()}
      />
    </AuthenticatedUserContext.Provider>
  );
}
