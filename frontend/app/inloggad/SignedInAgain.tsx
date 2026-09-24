"use client";

import { useEffect, useState } from "react";
import { SESSION_CHANNEL } from "@/components/SessionEndWarning";
import { authStatus } from "@/lib/api";
import { userDisplayName } from "@/lib/user-identity";

/** Why the backend refused a renewal (`?fel=`); the page's own login stays as it was. */
export type Refusal = "annan-anvandare" | "utgangen";

/**
 * Where a login renewed in its own window lands ("Fortsätt arbeta" before
 * the session ends): it tells the module's tabs, which read the new end,
 * and closes itself. A refused renewal says why and stays: `annan-anvandare`
 * when it signed in someone else, `utgangen` when the login had already
 * ended, so there was no user left to renew.
 */
export function SignedInAgain({ refusal }: { refusal: Refusal | null }) {
  const [name, setName] = useState<string | null>(null);

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

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-3 px-6 py-12">
      <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em] text-ink">
        {refusal === "annan-anvandare"
          ? "Du loggade in som en annan användare"
          : refusal === "utgangen"
            ? "Inloggningen har redan gått ut"
            : "Du är inloggad igen"}
      </h1>
      <p className="text-[17px] leading-relaxed text-ink-soft">
        {refusal === "annan-anvandare"
          ? `Stäng fönstret och logga in som ${name ?? "den som arbetar på sidan"} för att fortsätta.`
          : refusal === "utgangen"
            ? // This window cannot know whether the other tab's recording is kept on the device (see leaveWarning):
              // it promises nothing and says how to keep it, as "Lämna sidan?" does.
              "Stäng fönstret. Om du har en inspelning i den andra fliken: stoppa den och välj Spara som fil innan du loggar in igen. Uppgifter och ändringar som inte är sparade behöver fyllas i igen."
            : "Du kan stänga det här fönstret och fortsätta där du var."}
      </p>
    </main>
  );
}
