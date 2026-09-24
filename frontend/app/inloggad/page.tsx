"use client";

import { useEffect, useState } from "react";
import { useDocumentTitle } from "@/components/flow/recording-hooks";
import { SESSION_CHANNEL } from "@/components/SessionEndWarning";
import { authStatus } from "@/lib/api";
import { userDisplayName } from "@/lib/user-identity";

/**
 * Where a login renewed in its own window lands ("Fortsätt arbeta" before
 * the session ends): it tells the module's tabs, which read the new end,
 * and closes itself. When the renewal signed in someone else, the backend
 * kept the page's login and sends `?fel=annan-anvandare`: say so, and stay.
 */
export default function SignedInAgain() {
  const [otherUser, setOtherUser] = useState(false);
  const [name, setName] = useState<string | null>(null);
  useDocumentTitle(otherUser ? "Fel användare · Tal till text" : "Inloggad igen · Tal till text");

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("fel") === "annan-anvandare") {
      setOtherUser(true);
      // The page's own login is still the one in the cookie: its user is the one to sign in as.
      void authStatus().then((s) => s.user && setName(userDisplayName(s.user)), () => undefined);
      return;
    }
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(SESSION_CHANNEL);
      channel.postMessage("inloggad");
      channel.close();
    }
    window.close();
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-3 px-6 py-12">
      <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em] text-ink">
        {otherUser ? "Du loggade in som en annan användare" : "Du är inloggad igen"}
      </h1>
      <p className="text-[17px] leading-relaxed text-ink-soft">
        {otherUser
          ? `Stäng fönstret och logga in som ${name ?? "den som arbetar på sidan"} för att fortsätta.`
          : "Du kan stänga det här fönstret och fortsätta där du var."}
      </p>
    </main>
  );
}
