"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SESSION_CHANNEL, SessionEndWarning } from "@/components/SessionEndWarning";
import { Spinner } from "@/components/ui/spinner";
import { authStatus, type AuthStatus, type AuthenticatedUser } from "@/lib/api";
import { keepSessionAlive } from "@/lib/session-keepalive";
import { sessionUser } from "@/lib/user-identity";

// Exported for component tests; pages get the user through AuthGate.
export const AuthenticatedUserContext = createContext<AuthenticatedUser | null>(null);

export function useAuthenticatedUser(): AuthenticatedUser {
  const user = useContext(AuthenticatedUserContext);
  if (!user) {
    throw new Error("useAuthenticatedUser must be used inside AuthGate");
  }
  return user;
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  // When the login ends, and whether a new Eneo login in another window can move that.
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [canRenew, setCanRenew] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let stopKeepalive: (() => void) | undefined;

    const observe = (s: AuthStatus) => {
      if (!cancelled && s.authenticated && s.session_ends_in !== undefined) {
        const next = Date.now() + s.session_ends_in * 1000;
        // The same end read again moves by the request's second or so; only a new login moves it far.
        setEndsAt((current) => (current !== null && Math.abs(next - current) < 60_000 ? current : next));
        setCanRenew(s.auth_mode === "eneo_sso");
      }
      return s;
    };
    const recheck = () => void authStatus().then(observe, () => undefined);
    // A login renewed in its own window (or another tab) moves the end for this page too.
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(SESSION_CHANNEL);
    channel?.addEventListener("message", recheck);
    const onVisible = () => document.visibilityState === "visible" && recheck();
    document.addEventListener("visibilitychange", onVisible);

    authStatus()
      .then((s) => {
        if (cancelled) return;
        observe(s);
        // I access_code-läget saknar sessionen användare; sessionUser ger då
        // en platshållare så vi inte studsar tillbaka till loginsidan i en loop.
        const sessionIdentity = sessionUser(s);
        if (!sessionIdentity) {
          router.replace("/");
        } else {
          setUser(sessionIdentity);
          stopKeepalive = keepSessionAlive(s, () => authStatus().then(observe));
        }
      })
      .catch(() => {
        if (!cancelled) router.replace("/");
      });

    return () => {
      cancelled = true;
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
      {children}
      <SessionEndWarning endsAt={endsAt} canRenew={canRenew} />
    </AuthenticatedUserContext.Provider>
  );
}
