"use client";

import { Loader2 } from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authStatus, type AuthenticatedUser } from "@/lib/api";
import { sessionUser } from "@/lib/user-identity";

const AuthenticatedUserContext = createContext<AuthenticatedUser | null>(null);

// Backend förnyar Eneo-token när den närmar sig utgång, men bara när ett anrop
// kommer in. En lång inspelning gör inga andra anrop, så sidan frågar efter
// sessionen med jämna mellanrum så länge den är öppen.
const SESSION_KEEPALIVE_MS = 60_000;

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
        }
      })
      .catch(() => {
        if (!cancelled) router.replace("/");
      });

    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    // Svaret behövs inte; nästa riktiga anrop hanterar en avslutad session.
    const id = setInterval(() => {
      authStatus().catch(() => undefined);
    }, SESSION_KEEPALIVE_MS);
    return () => clearInterval(id);
  }, []);

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
