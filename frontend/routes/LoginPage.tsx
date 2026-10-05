"use client";

import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { authStatus } from "@/lib/api";
import { HeaderBrand } from "@/components/AppHeader";
import { UNREACHABLE } from "@/components/ModuleUnreachable";
import { ModuleShell } from "@/kit/ModuleShell";
import { useRouteReady } from "@/routes/RouteEffects";

export default function LoginPage() {
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  // False when the module could not be asked who is signed in: the way in is then a second try.
  const [reachable, setReachable] = useState(false);

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
          setReachable(true);
          setChecking(false);
        }
      })
      .catch(() => {
        setAuthError(UNREACHABLE);
        setChecking(false);
      });
  }, [navigate]);

  // The page has its content once it has stopped asking who is signed in.
  useRouteReady(!checking);

  // Back from Eneo, the browser may show this page again as it was left, with the button still opening Eneo.
  useEffect(() => {
    const shownAgain = (event: PageTransitionEvent) => event.persisted && setSubmitting(false);
    window.addEventListener("pageshow", shownAgain);
    return () => window.removeEventListener("pageshow", shownAgain);
  }, []);

  function startLogin() {
    setSubmitting(true);
    setAuthError(null);
    window.location.assign("/api/auth/login");
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
                Logga in via Eneo för att fortsätta.
              </Text>
            </VStack>

            {authError && <Banner status="error" title={authError} collapsible={false} />}
            {reachable && (
              <HStack>
                <Button
                  label={submitting ? "Öppnar Eneo…" : "Logga in med Eneo"}
                  variant="primary"
                  isLoading={submitting}
                  onClick={startLogin}
                />
              </HStack>
            )}
            {!reachable && (
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
