import { ServerOff, WifiOff } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { onlineStatus, type Connection, type OnlineStatus } from "@/lib/online-status";
export type OfflineWaiting = "recording" | "upload" | "run" | null;

// A device with no network says so; a module that does not answer says that, and neither blames the other.
const MESSAGES: Record<"offline" | "unreachable", Record<NonNullable<OfflineWaiting> | "nothing", string>> = {
  offline: {
    // Where the recording is kept is said beside the recorder, only when it is true.
    recording: "Ingen anslutning. Inspelningen fortsätter.",
    upload: "Ingen anslutning. Uppladdningen fortsätter när anslutningen är tillbaka.",
    run: "Ingen anslutning. Körningen fortsätter i Eneo och visas här när anslutningen är tillbaka.",
    nothing: "Ingen anslutning.",
  },
  unreachable: {
    recording: "Tal till text svarar inte just nu. Inspelningen fortsätter.",
    upload: "Tal till text svarar inte just nu. Uppladdningen fortsätter när det svarar igen.",
    run: "Tal till text svarar inte just nu. Körningen fortsätter i Eneo och visas här när det svarar igen.",
    nothing: "Tal till text svarar inte just nu.",
  },
};

/**
 * Says what waits while the device has no network or the module does not answer. The status region is always rendered, so a screen reader announces the
 * change once; it takes no room, so a page that is online has no gap where the notice would be.
 *
 * The notice usually arrives late, above what the person is looking at (an answer brought above the docked action on a
 * phone). The browser keeps what is on screen in place when something appears above it (scroll anchoring), but not at
 * the page's top and not in Safari: there the notice scrolls the window by the room it takes, so nothing on screen moves.
 */
export function OfflineBanner({ waiting, status = onlineStatus }: { waiting: OfflineWaiting; status?: OnlineStatus }) {
  const card = useRef<HTMLDivElement>(null);
  const region = useRef<HTMLParagraphElement>(null);
  const before = useRef<{ following: Element; top: number } | null>(null);
  const subscribe = useCallback(
    (onChange: () => void) =>
      status.subscribe(() => {
        const following = (card.current ?? region.current)?.nextElementSibling;
        // Keep an answer already brought into view above a dock at its visible pixel.
        const answer = following?.matches('[role="alert"]') ? following : following?.querySelector('[role="alert"]');
        const answerTop = answer?.getBoundingClientRect().top;
        const anchor = answer && answerTop !== undefined && answerTop >= 0 && answerTop < window.innerHeight ? answer : following;
        before.current = anchor ? { following: anchor, top: anchor.getBoundingClientRect().top } : null;
        onChange();
      }),
    [status],
  );
  const connection = useSyncExternalStore<Connection>(subscribe, () => status.connection, () => "online");

  useLayoutEffect(() => {
    const was = before.current;
    before.current = null;
    if (!was?.following.isConnected) return;
    const top = was.following.getBoundingClientRect().top;
    // Scroll positions are rounded to pixels. Preserve the visible content's pixel rather than rounding the notice's
    // fractional height, which can move that content by one pixel. Browser scroll anchoring is already reflected here.
    const shift = Math.round(top) - Math.round(was.top);
    if (shift !== 0 && (card.current?.getBoundingClientRect().top ?? top) < window.innerHeight) {
      window.scrollBy({ top: shift, behavior: "instant" });
    }
  }, [connection]);

  const message = connection === "online" ? "" : MESSAGES[connection][waiting ?? "nothing"];
  return (
    <>
      <VisuallyHidden ref={region} as="p" role="status">
        {message}
      </VisuallyHidden>
      {/* What the status says, for the eye: the region above reads it out. */}
      {connection !== "online" && (
        <Card ref={card} variant="muted" padding={3} aria-hidden>
          <HStack gap={3} align="start">
            <Icon icon={connection === "offline" ? WifiOff : ServerOff} color="secondary" />
            <Text as="p" type="supporting">
              {message}
            </Text>
          </HStack>
        </Card>
      )}
    </>
  );
}
