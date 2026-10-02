"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { ApiError, authStatus, loginWithAccessCode } from "@/lib/api";
import type { AuthMode } from "@/lib/api";
import { HeaderBrand } from "@/components/AppHeader";
import { ModuleShell } from "@/kit/ModuleShell";

// TextInput hands what it does not type on to its <input>: the browser stops an empty code before it is sent, and
// the field takes no more than the backend does (256), as before.
const CODE_FIELD_LIMITS = { required: true, maxLength: 256 };

// The error's own element, which the field in error points at. TextInput computes aria-describedby itself and
// would overwrite one given here, so the pointer is aria-errormessage: it names the message without a second
// announcement (the banner's role="alert" says it once, when it appears).
const ERROR_ID = "login-error";

export default function LoginPage() {
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const [accessCode, setAccessCode] = useState("");
  const codeField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("auth_error")) {
      setAuthError("Inloggningen kunde inte slutföras. Försök igen.");
      void navigate("/", { replace: true });
    }
    authStatus()
      .then((s) => {
        if (s.authenticated) void navigate("/flows", { replace: true });
        else {
          setAuthMode(s.auth_mode);
          setChecking(false);
        }
      })
      .catch(() => {
        setAuthError("Kunde inte kontakta modulen. Försök igen.");
        setChecking(false);
      });
  }, [navigate]);

  // The field is locked while a code is checked, which drops focus: a refused code gives it back, to type again.
  useEffect(() => {
    if (authError && !submitting) codeField.current?.focus();
  }, [authError, submitting]);

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
      void navigate("/flows", { replace: true });
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
      <ModuleShell label="Tal till text" heading={<HeaderBrand linked={false} />}>
        <VStack hAlign="center" paddingBlock={10}>
          <VisuallyHidden as="h1">Tal till text</VisuallyHidden>
          <Spinner aria-label="Laddar" />
        </VStack>
      </ModuleShell>
    );
  }

  return (
    <ModuleShell label="Tal till text" heading={<HeaderBrand linked={false} />}>
      <Layout height="auto" contentWidth={640} padding={4}>
        <LayoutContent isScrollable={false}>
          <VStack gap={6} paddingBlockStart={6}>
            <VStack gap={2}>
              <Heading level={1}>Gör samtal och filer till text och dokument.</Heading>
              <Text as="p" color="secondary">
                {authMode === "access_code"
                  ? "Ange åtkomstkoden för att fortsätta."
                  : "Logga in via Eneo för att fortsätta."}
              </Text>
            </VStack>

            {authError && <Banner id={ERROR_ID} status="error" title={authError} collapsible={false} />}
            {authMode === "eneo_sso" && (
              <HStack>
                <Button
                  label={submitting ? "Öppnar Eneo…" : "Logga in med Eneo"}
                  variant="primary"
                  isLoading={submitting}
                  onClick={startLogin}
                />
              </HStack>
            )}
            {authMode === "access_code" && (
              <form onSubmit={submitAccessCode}>
                <VStack gap={4}>
                  <TextInput
                    ref={codeField}
                    type="password"
                    label="Åtkomstkod"
                    value={accessCode}
                    onChange={setAccessCode}
                    // A password manager may keep and fill the code (WCAG 3.3.8); pasting works either way.
                    autoComplete="current-password"
                    {...CODE_FIELD_LIMITS}
                    isDisabled={submitting}
                    status={authError ? { type: "error" } : undefined}
                    aria-errormessage={authError ? ERROR_ID : undefined}
                    hasAutoFocus
                  />
                  <HStack>
                    <Button
                      type="submit"
                      label={submitting ? "Loggar in…" : "Fortsätt"}
                      variant="primary"
                      isLoading={submitting}
                    />
                  </HStack>
                </VStack>
              </form>
            )}
            {authMode === null && (
              <HStack>
                <Button label="Försök igen" onClick={() => window.location.reload()} />
              </HStack>
            )}
          </VStack>
        </LayoutContent>
      </Layout>
    </ModuleShell>
  );
}
