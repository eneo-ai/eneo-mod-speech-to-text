"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, authStatus, loginWithAccessCode } from "@/lib/api";
import type { AuthMode } from "@/lib/api";
import { AppHeader } from "@/components/AppHeader";
import { FRAME, READING } from "@/components/frame";
import { cn } from "@/lib/utils";

export default function LoginPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const [accessCode, setAccessCode] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("auth_error")) {
      setAuthError("Inloggningen kunde inte slutföras. Försök igen.");
      window.history.replaceState(null, "", "/");
    }
    authStatus()
      .then((s) => {
        if (s.authenticated) router.replace("/flows");
        else {
          setAuthMode(s.auth_mode);
          setChecking(false);
        }
      })
      .catch(() => {
        setAuthError("Kunde inte kontakta modulen. Försök igen.");
        setChecking(false);
      });
  }, [router]);

  function startLogin() {
    setSubmitting(true);
    setAuthError(null);
    window.location.assign("/api/auth/login");
  }

  async function submitAccessCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setAuthError(null);
    try {
      await loginWithAccessCode(accessCode);
      router.replace("/flows");
    } catch (error) {
      setAuthError(
        error instanceof ApiError && error.status === 401
          ? "Felaktig åtkomstkod."
          : "Inloggningen kunde inte slutföras. Försök igen.",
      );
      setSubmitting(false);
    }
  }

  if (checking) {
    return (
      <main className="min-h-screen grid place-items-center">
        <Spinner className="size-5 text-ink-mute" />
      </main>
    );
  }

  return (
    <>
      <AppHeader account={false} />
      <main
        className={cn(
          FRAME,
          "flex flex-1 flex-col pb-16 pt-2 md:justify-center",
        )}
      >
        <div className={READING}>
          <div className="space-y-2 mb-8">
            <h1 className="text-[30px] md:text-[36px] font-semibold tracking-[-0.025em] leading-[1.05]">
              Gör samtal och filer till text och dokument.
            </h1>
            <p className="text-[14px] text-ink-soft leading-relaxed pt-1">
              {authMode === "access_code"
                ? "Ange åtkomstkoden för att fortsätta."
                : "Logga in via Eneo för att fortsätta."}
            </p>
          </div>

          <div className="space-y-6 mt-2">
            {authError && (
              <p
                id="login-error"
                className="text-sm text-destructive"
                role="alert"
              >
                {authError}
              </p>
            )}
            {authMode === "eneo_sso" && (
              <Button
                type="button"
                onClick={startLogin}
                disabled={submitting}
                className="w-full sm:w-auto"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting ? "Öppnar Eneo…" : "Logga in med Eneo"}
              </Button>
            )}
            {authMode === "access_code" && (
              <form className="space-y-4" onSubmit={submitAccessCode}>
                <div className="space-y-2">
                  <Label htmlFor="access-code">Åtkomstkod</Label>
                  <Input
                    id="access-code"
                    type="password"
                    value={accessCode}
                    onChange={(event) => setAccessCode(event.target.value)}
                    autoComplete="off"
                    required
                    maxLength={256}
                    disabled={submitting}
                    aria-invalid={authError ? true : undefined}
                    aria-describedby={authError ? "login-error" : undefined}
                    autoFocus
                  />
                </div>
                <Button
                  type="submit"
                  disabled={submitting}
                  className="w-full sm:w-auto"
                >
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {submitting ? "Loggar in…" : "Fortsätt"}
                </Button>
              </form>
            )}
            {authMode === null && (
              <Button
                type="button"
                variant="outline"
                onClick={() => window.location.reload()}
                className="w-full sm:w-auto"
              >
                Försök igen
              </Button>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
