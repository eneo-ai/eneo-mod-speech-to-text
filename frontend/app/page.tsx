"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authStatus } from "@/lib/api";
import { Brand } from "@/components/Brand";

export default function LoginPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [authError, setAuthError] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("auth_error")) {
      setAuthError(true);
      window.history.replaceState(null, "", "/");
    }
    authStatus()
      .then((s) => {
        if (s.authenticated) router.replace("/flows");
        else setChecking(false);
      })
      .catch(() => setChecking(false));
  }, [router]);

  function startLogin() {
    setSubmitting(true);
    setAuthError(false);
    window.location.assign("/api/auth/login");
  }

  if (checking) {
    return (
      <main className="min-h-screen grid place-items-center">
        <Loader2 className="h-5 w-5 animate-spin text-ink-mute" />
      </main>
    );
  }

  return (
    <main className="flex flex-col flex-1 px-6 md:px-8 py-10 w-full mx-auto max-w-md md:max-w-lg md:justify-center">
      <header className="flex items-center justify-between mb-12">
        <Brand />
      </header>

      <div className="space-y-2 mb-8">
        <div className="eyebrow">v0.4 · Demo</div>
        <h1 className="text-[30px] md:text-[36px] font-semibold tracking-[-0.025em] leading-[1.05]">
          Spela in samtal — <span className="accent-em">i fickformat</span>
        </h1>
        <p className="text-[14px] text-ink-soft leading-relaxed pt-1">
          Logga in via Eneo för att fortsätta.
        </p>
      </div>

      <div className="space-y-6 mt-2">
        {authError && (
          <p className="text-sm text-accent" role="alert">
            Inloggningen kunde inte slutföras. Försök igen.
          </p>
        )}
        <Button
          type="button"
          onClick={startLogin}
          disabled={submitting}
          className="w-full"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitting ? "Öppnar Eneo…" : "Logga in med Eneo"}
        </Button>
      </div>
    </main>
  );
}
