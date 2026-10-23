import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { authStatus } from "@/lib/api";
import { useOwnOrganization } from "@/components/Brand";
import { HeaderBrand } from "@/components/HeaderBrand";
import styles from "./LoginPage.module.css";
import { ModuleShell } from "@/kit/ModuleShell";
import { connectionLost } from "@/lib/online-status";
import { useRouteReady } from "@/routes/RouteEffects";
import { PRODUCT_NAME } from "@/lib/product";
import { isRecord } from "@/lib/is-record";

/**
 * Where the page that sent the person here was going (AuthGate puts it in the route's state): a path of this module, never
 * another site, by the rule the backend applies to its own copy (`module_path` in backend/app/module_auth.py).
 */
function returnAddress(state: unknown): string | null {
  const next = isRecord(state) ? state.next : null;
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : null;
}

export default function LoginPage() {
  const navigate = useNavigate();
  const organization = useOwnOrganization();
  const narrow = useMediaQuery("(max-width: 639.98px)");
  const location = useLocation();
  const [submitting, setSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  // False when the module could not be asked who is signed in: the way in is then a second try.
  const [reachable, setReachable] = useState(false);
  const signedOut = reachable && isRecord(location.state) && location.state.signedOut === true;
  // Read once: cleaning `auth_error` from the address replaces the entry, and its state with it.
  const [next] = useState(() => returnAddress(location.state));

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("auth_error")) {
      setAuthError("Inloggningen kunde inte slutföras. Försök igen.");
      void navigate("/", { replace: true });
    }
    authStatus()
      .then((s) => {
        if (s.authenticated) void navigate(next ?? "/flows", { replace: true });
        else {
          setReachable(true);
          setChecking(false);
        }
      })
      .catch(() => {
        setAuthError(connectionLost());
        setChecking(false);
      });
  }, [navigate, next]);

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
    window.location.assign(next ? `/api/auth/login?${new URLSearchParams({ next })}` : "/api/auth/login");
  }

  if (checking) {
    return (
      <ModuleShell label={PRODUCT_NAME} heading={<HeaderBrand linked={false} />}>
        <VStack hAlign="center" paddingBlock={10}>
          <VisuallyHidden as="h1">{PRODUCT_NAME}</VisuallyHidden>
          <Spinner aria-label="Laddar" />
        </VStack>
      </ModuleShell>
    );
  }

  return (
    <ModuleShell label={PRODUCT_NAME} heading={<HeaderBrand linked={false} />}>
      {/* One thing on the page: a card in a narrow centred column, a third of the way down from a tablet's width, on the
          page's ground. The brand stands in the bar, so the card leads with its heading. */}
      <Layout height="auto" contentWidth={480} padding={4}>
        <LayoutContent isScrollable={false}>
          <VStack gap={4} className={styles.column}>
            <Card padding={narrow ? 6 : 8}>
              <VStack gap={6} hAlign="stretch">
                {/* The heading at the card's own size, two balanced lines in its 480 px; the button says whom one signs in
                    with, so nothing under the heading repeats it. */}
                <VStack gap={2}>
                  <Heading level={1}>{signedOut ? "Du är utloggad" : "Gör samtal och filer till text och dokument."}</Heading>
                  {signedOut && (
                    <>
                      <Text as="p" color="secondary">
                        Inspelningar som inte har skickats ligger kvar i den här webbläsaren tills du skickar eller tar bort dem. Logga
                        in med samma konto för att fortsätta.
                      </Text>
                      <Text as="p" color="secondary">Använd en egen webbläsarprofil om du delar dator med andra.</Text>
                    </>
                  )}
                </VStack>

                {authError && <Banner status="error" title={authError} collapsible={false} />}
                {/* The one action the page exists for: the primary's own size, across the card. */}
                {reachable && (
                  <Button
                    label={submitting ? "Öppnar Eneo…" : "Logga in med Eneo"}
                    variant="primary"
                    size="lg"
                    width="100%"
                    isLoading={submitting}
                    onClick={startLogin}
                  />
                )}
                {!reachable && <Button label="Försök igen" width="100%" onClick={() => window.location.reload()} />}
              </VStack>
            </Card>
            {/* Whose tool this is, where a deployment has named itself: the page is Eneo's otherwise. */}
            {organization && (
              <Text as="p" type="supporting" color="secondary" justify="center">
                {organization.name} använder Eneo.
              </Text>
            )}
          </VStack>
        </LayoutContent>
      </Layout>
    </ModuleShell>
  );
}
