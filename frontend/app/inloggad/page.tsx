"use client";

import { useEffect } from "react";
import { useDocumentTitle } from "@/components/flow/recording-hooks";
import { SESSION_CHANNEL } from "@/components/SessionEndWarning";

/**
 * Where a login renewed in its own window lands ("Fortsätt arbeta" before
 * the session ends): it tells the module's tabs, which read the new end,
 * and closes itself.
 */
export default function SignedInAgain() {
  useDocumentTitle("Inloggad igen · Tal till text");
  useEffect(() => {
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(SESSION_CHANNEL);
      channel.postMessage("inloggad");
      channel.close();
    }
    window.close();
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-3 px-6 py-12">
      <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em] text-ink">Du är inloggad igen</h1>
      <p className="text-[17px] leading-relaxed text-ink-soft">Du kan stänga det här fönstret och fortsätta där du var.</p>
    </main>
  );
}
