"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { Heading } from "@astryxdesign/core/Heading";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useDocumentTitle } from "@/components/flow/recording-hooks";
import { authStatus } from "@/lib/api";
import { SESSION_CHANNEL } from "@/lib/login-state";
import { userDisplayName } from "@/lib/user-identity";
import { useRouteReady } from "@/routes/RouteEffects";
import { documentTitle } from "@/lib/product";

/** Why the backend refused a renewal (`?fel=`); the page's own login stays as it was. */
type Refusal = "annan-anvandare" | "utgangen";

/** Any other value of `fel` is no refusal: the page is the plain "inloggad igen". */
const refusalOf = (fel: string | null): Refusal | null => (fel === "annan-anvandare" || fel === "utgangen" ? fel : null);

const TITLE: Record<Refusal | "ok", string> = {
  ok: documentTitle("Inloggad igen"),
  "annan-anvandare": documentTitle("Fel användare"),
  utgangen: documentTitle("Inloggningen har gått ut"),
};

/** The route /inloggad, where a login window lands. It is outside every gate: no AuthGate, and no way off the page when nobody is signed in. */
export default function SignedInAgainPage() {
  const [params] = useSearchParams();
  return <SignedInAgain refusal={refusalOf(params.get("fel"))} />;
}

/**
 * Where a login renewed in its own window lands ("Fortsätt arbeta" before
 * the session ends): it tells the module's tabs, which read the new end,
 * and closes itself. A refused renewal says why and stays: `annan-anvandare`
 * when it signed in someone else, `utgangen` when the login had already
 * ended, so there was no user left to renew.
 */
function SignedInAgain({ refusal }: { refusal: Refusal | null }) {
  const [name, setName] = useState<string | null>(null);
  useDocumentTitle(TITLE[refusal ?? "ok"]);
  // Nothing here is waited for.
  useRouteReady(true);

  useEffect(() => {
    if (refusal === "annan-anvandare") {
      // The page's own login is still the one in the cookie: its user is the one to sign in as.
      void authStatus().then((s) => s.user && setName(userDisplayName(s.user)), () => undefined);
      return;
    }
    if (refusal) return;
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(SESSION_CHANNEL);
      channel.postMessage("inloggad");
      channel.close();
    }
    window.close();
  }, [refusal]);

  // A popup window: no top bar and no account menu, so the page's own main region and one readable column.
  return (
    <Layout height="auto" contentWidth={640}>
      <LayoutContent role="main" padding={6} isScrollable={false}>
        <VStack gap={3} hAlign="start">
          <Heading level={1}>
            {refusal === "annan-anvandare"
              ? "Du loggade in som en annan användare"
              : refusal === "utgangen"
                ? "Inloggningen har redan gått ut"
                : "Du är inloggad igen"}
          </Heading>
          <Text as="p" color="secondary">
            {refusal === "annan-anvandare"
              ? `Stäng fönstret och logga in som ${name ?? "den som arbetar på sidan"} för att fortsätta.`
              : refusal === "utgangen"
                ? // This window cannot know whether the other tab's recording is kept on the device (see leaveWarning):
                  // it promises nothing and says how to keep it, as "Lämna sidan?" does.
                  "Stäng fönstret. Om du har en inspelning i den andra fliken: stoppa den och välj Spara som fil innan du loggar in igen. Uppgifter och ändringar som inte är sparade behöver fyllas i igen."
                : "Du kan stänga det här fönstret och fortsätta där du var."}
          </Text>
        </VStack>
      </LayoutContent>
    </Layout>
  );
}
