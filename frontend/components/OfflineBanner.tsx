"use client";

import { WifiOff } from "lucide-react";
import { useSyncExternalStore } from "react";
import { onlineStatus } from "@/lib/online-status";

const subscribe = (onChange: () => void) => onlineStatus.subscribe(onChange);

function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, () => onlineStatus.online, () => true);
}

export type OfflineWaiting = "recording" | "upload" | "run" | null;

const MESSAGES: Record<NonNullable<OfflineWaiting>, string> = {
  // Where the recording is kept is said beside the recorder, only when it is true.
  recording: "Ingen anslutning. Inspelningen fortsätter.",
  upload: "Ingen anslutning. Uppladdningen fortsätter när anslutningen är tillbaka.",
  run: "Ingen anslutning. Körningen fortsätter i Eneo och visas här när anslutningen är tillbaka.",
};

/**
 * Says what waits while the device is offline. The status region is always
 * rendered, so a screen reader announces the change once.
 */
export function OfflineBanner({ waiting }: { waiting: OfflineWaiting }) {
  const online = useOnlineStatus();
  return (
    <div role="status">
      {!online && (
        <p className="mb-4 flex items-start gap-3 rounded-2xl border border-rule-soft bg-paper px-4 py-3 text-[13px] leading-snug text-ink">
          <WifiOff aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-ink-soft" strokeWidth={2} />
          {waiting ? MESSAGES[waiting] : "Ingen anslutning."}
        </p>
      )}
    </div>
  );
}
