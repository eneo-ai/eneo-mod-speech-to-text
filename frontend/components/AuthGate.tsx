import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import { LoadingShell } from "@/components/LoadingShell";
import { SESSION_CHANNEL, SessionEndWarning } from "@/components/SessionEndWarning";
import styles from "@/components/AuthGate.module.css";
import { authStatus, type AuthStatus, type AuthenticatedUser } from "@/lib/api";
import { browserStorage } from "@/lib/browser-storage";
import { keepOnlyConfirmedWordsOf } from "@/lib/confirmed-words";
import { browserDrafts, keepOnlyDraftsOf } from "@/lib/drafts";
import { loginState, type Question } from "@/lib/login-state";
import { keepSessionAlive } from "@/lib/session-keepalive";
import { sessionUser } from "@/lib/user-identity";

// Exported for component tests; pages get the user through AuthGate.
export const AuthenticatedUserContext = createContext<AuthenticatedUser | null>(null);

/** While the page is covered for a new login: the place in the sign-in dialog for its recording controls. */
export const SignedOutSlot = createContext<HTMLElement | null>(null);

/**
 * Whether the page's login has ended. A native dialog of the page is in the top layer and escapes the cover's inert,
 * hidden wrapper: it stays visible and focusable above the page. So each page dialog closes itself while this holds
 * and opens again after the new login, with its state kept above it (design decision D6, point 3). Taking this away
 * fails the cover specs of every dialog (tests/e2e/session-cover.spec.ts), measured on the merged tip.
 */
export function useSignedOut(): boolean {
  return useSyncExternalStore(loginState.subscribe, () => loginState.signedOut, () => false);
}

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
export function SignedOutCover({
  signedOut,
  focusBack,
  children,
}: {
  signedOut: boolean;
  /** Set here: gives the focus back once the sign-in dialog has closed after a new login (SessionEndWarning). */
  focusBack?: { current: ((before: HTMLElement | null) => void) | null };
  children: React.ReactNode;
}) {
  // The page's own element, which the focus is kept to and given back into.
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
  // Back where it was on the page when the login ended, or before the warning that was open then (`before`), or on
  // the page's heading when neither is on the page any more.
  if (focusBack) {
    focusBack.current = (before) => {
      const from = lost.current?.from ?? null;
      lost.current = null;
      const onPage = (element: HTMLElement | null) => !!element?.isConnected && !!container?.contains(element);
      const heading = container?.querySelector<HTMLElement>("[data-phase-heading], h1[tabindex]") ?? null;
      (onPage(from) ? from : onPage(before) ? before : heading)?.focus();
    };
  }
  return (
    <div ref={setContainer} className={signedOut ? styles.pageSignedOut : styles.page} inert={signedOut}>
      {children}
    </div>
  );
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  // When the login ends, and how a new login moves that.
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const signedOut = useSignedOut();
  const otherUser = useSyncExternalStore(loginState.subscribe, () => loginState.otherUser, () => null);
  const [controls, setControls] = useState<HTMLElement | null>(null);
  const focusBack = useRef<((before: HTMLElement | null) => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    let stopKeepalive: (() => void) | undefined;
    let channel: BroadcastChannel | null = null;

    let endPage: (() => void) | undefined;
    const observe = (s: AuthStatus, question: Question) => {
      // Signed in, until when, or signed out: the page asks for a new login in place, never navigates. An answer to
      // a read asked before the login changed, or before one already answered, is about a login that is gone: it
      // moves no end or keepalive either.
      if (!loginState.observe(s, question)) return false;
      if (s.authenticated && s.session_ends_in !== undefined) {
        const next = Date.now() + s.session_ends_in * 1000;
        // The same end read again moves by the request's second or so; only a new login moves it far.
        setEndsAt((current) => (current !== null && Math.abs(next - current) < 60_000 ? current : next));
      }
      return true;
    };
    // Answers can come back out of order (a slow check, then a renewal's): the login state takes only an answer to a
    // later question than the last one used. A stopped keepalive's answers count the same way.
    const read = async (): Promise<AuthStatus | null> => {
      const question = loginState.ask();
      const s = await authStatus();
      if (cancelled) return null;
      return observe(s, question) ? s : null;
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
    // A login window of the module says it is done (the page it lands on, /inloggad, tells the session channel): a new
    // login is announced, also when the page was never covered, so what went out on the old session is obsolete at
    // once, and the status read that follows decides.
    const renewed = () => {
      loginState.loginWindowDone();
      recheck();
    };
    const onVisible = () => document.visibilityState === "visible" && recheck();

    read()
      .then((s) => {
        if (!s) return;
        const sessionIdentity = sessionUser(s);
        if (!sessionIdentity) {
          void navigate("/", { replace: true });
          return;
        }
        setUser(sessionIdentity);
        // Someone else's unsent details and edits are not this person's to see.
        keepOnlyDraftsOf(browserDrafts(), sessionIdentity.id);
        keepOnlyConfirmedWordsOf(browserStorage(), sessionIdentity.id);
        endPage = loginState.begin(sessionIdentity, recheck);
        keepAlive(s);
        // From here a login renewed in its own window (or another tab) moves the end for this page too.
        channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(SESSION_CHANNEL);
        channel?.addEventListener("message", renewed);
        document.addEventListener("visibilitychange", onVisible);
      })
      .catch(() => {
        if (!cancelled) void navigate("/", { replace: true });
      });

    return () => {
      cancelled = true;
      endPage?.();
      stopKeepalive?.();
      channel?.close();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [navigate]);

  if (!user) return <LoadingShell />;

  return (
    <AuthenticatedUserContext.Provider value={user}>
      <SignedOutSlot.Provider value={controls}>
        <SignedOutCover signedOut={signedOut} focusBack={focusBack}>
          {children}
        </SignedOutCover>
      </SignedOutSlot.Provider>
      <SessionEndWarning
        endsAt={endsAt}
        signedOut={signedOut}
        owner={user}
        otherUser={otherUser}
        controlsRef={setControls}
        onFocusBack={(before) => focusBack.current?.(before)}
      />
    </AuthenticatedUserContext.Provider>
  );
}
