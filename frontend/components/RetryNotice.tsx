"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { RetryWait } from "@/lib/submit-run";

/**
 * Shown while a send waits to try again. The countdown stays outside the live
 * region, so a screen reader hears one sentence rather than every second.
 */
export function RetryNotice({ wait }: { wait: RetryWait | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!wait) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [wait]);
  const seconds = wait ? Math.max(0, Math.ceil((wait.retryAt - now) / 1_000)) : 0;

  return (
    <div className="w-full">
      <p role="status" className="sr-only">
        {wait ? "Det gick inte att skicka just nu. Försöker igen automatiskt." : ""}
      </p>
      {wait && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-ink-soft">
            Det gick inte att skicka just nu. Försöker igen om {seconds} s.
          </p>
          <Button type="button" variant="outline" className="h-11" onClick={wait.retryNow}>
            Försök nu
          </Button>
        </div>
      )}
    </div>
  );
}
