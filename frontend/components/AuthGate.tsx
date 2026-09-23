"use client";

import { Loader2 } from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authStatus, type AuthenticatedUser } from "@/lib/api";
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

  useEffect(() => {
    let cancelled = false;
    let stopKeepalive: (() => void) | undefined;

    authStatus()
      .then((s) => {
        if (cancelled) return;
        // I access_code-läget saknar sessionen användare; sessionUser ger då
        // en platshållare så vi inte studsar tillbaka till loginsidan i en loop.
        const sessionIdentity = sessionUser(s);
        if (!sessionIdentity) {
          router.replace("/");
        } else {
          setUser(sessionIdentity);
          stopKeepalive = keepSessionAlive(s, authStatus);
        }
      })
      .catch(() => {
        if (!cancelled) router.replace("/");
      });

    return () => {
      cancelled = true;
      stopKeepalive?.();
    };
  }, [router]);

  if (!user) {
    return (
      <main className="min-h-screen grid place-items-center">
        <Loader2 className="h-5 w-5 animate-spin text-ink-mute" />
      </main>
    );
  }

  return (
    <AuthenticatedUserContext.Provider value={user}>
      {children}
    </AuthenticatedUserContext.Provider>
  );
}
