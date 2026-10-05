import { WifiOff } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { onlineStatus } from "@/lib/online-status";

export type OfflineWaiting = "recording" | "upload" | "run" | null;

const MESSAGES: Record<NonNullable<OfflineWaiting>, string> = {
  // Where the recording is kept is said beside the recorder, only when it is true.
  recording: "Ingen anslutning. Inspelningen fortsätter.",
  upload: "Ingen anslutning. Uppladdningen fortsätter när anslutningen är tillbaka.",
  run: "Ingen anslutning. Körningen fortsätter i Eneo och visas här när anslutningen är tillbaka.",
};

/** Where the notice stands in the window, and the room it takes in its stack: its height and the gap after it. */
function measure(card: HTMLElement) {
  const box = card.getBoundingClientRect();
  return { top: box.top, room: box.height + (parseFloat(getComputedStyle(card.parentElement!).rowGap) || 0) };
}

/**
 * Says what waits while the device is offline. The status region is always rendered, so a screen reader announces the
 * change once; it takes no room, so a page that is online has no gap where the notice would be.
 *
 * The notice usually arrives late, above what the person is looking at (an answer brought above the docked action on a
 * phone). The browser keeps what is on screen in place when something appears above it (scroll anchoring), but not at
 * the page's top and not in Safari: there the notice scrolls the window by the room it takes, so nothing on screen moves.
 */
export function OfflineBanner({ waiting }: { waiting: OfflineWaiting }) {
  const card = useRef<HTMLDivElement>(null);
  // The window as it was just before the notice showed or went.
  const before = useRef<{ scrollY: number; top: number; room: number } | null>(null);
  const subscribe = useCallback(
    (onChange: () => void) =>
      onlineStatus.subscribe(() => {
        before.current = { scrollY: window.scrollY, ...(card.current ? measure(card.current) : { top: Infinity, room: 0 }) };
        onChange();
      }),
    [],
  );
  const online = useSyncExternalStore(subscribe, () => onlineStatus.online, () => true);

  useLayoutEffect(() => {
    const was = before.current;
    before.current = null;
    if (!was) return;
    const now = card.current ? measure(card.current) : { top: was.top, room: 0 };
    // How far what follows the notice moved, less what the browser's own anchoring has already scrolled back.
    const shift = now.room - was.room - (window.scrollY - was.scrollY);
    // A notice below the window moves nothing on screen.
    if (shift !== 0 && now.top < window.innerHeight) window.scrollBy({ top: shift, behavior: "instant" });
  }, [online]);

  const message = waiting ? MESSAGES[waiting] : "Ingen anslutning.";
  return (
    <>
      <VisuallyHidden as="p" role="status">
        {online ? "" : message}
      </VisuallyHidden>
      {/* What the status says, for the eye: the region above reads it out. */}
      {!online && (
        <Card ref={card} variant="muted" padding={3} aria-hidden>
          <HStack gap={3} align="start">
            <Icon icon={WifiOff} color="secondary" />
            <Text as="p" type="supporting">
              {message}
            </Text>
          </HStack>
        </Card>
      )}
    </>
  );
}
