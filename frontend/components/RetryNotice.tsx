import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { onlineStatus, type OnlineStatus } from "@/lib/online-status";
import type { RetryWait } from "@/lib/submit-run";
import { moveFocusToHeading } from "@/routes/RouteEffects";

/**
 * Shown while a send waits to try again. The countdown stays outside the live
 * region, so a screen reader hears one sentence rather than every second. While
 * the page's offline notice (OfflineBanner) says why nothing goes, this one says
 * only when it tries again: the failure is said once.
 */
export function RetryNotice({ wait, status = onlineStatus }: { wait: RetryWait | null; status?: OnlineStatus }) {
  const said = useSyncExternalStore(status.subscribe, () => status.connection !== "online", () => false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!wait) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [wait]);
  const seconds = wait?.retryAt != null ? Math.max(0, Math.ceil((wait.retryAt - now) / 1_000)) : 0;
  // A press ends the wait and the button with it: the focus it had goes to the view's heading, not the page's body.
  const pressed = useRef(false);
  useEffect(() => {
    if (!wait && pressed.current) moveFocusToHeading();
    pressed.current = false;
  }, [wait]);

  return (
    <VStack gap={3}>
      <VisuallyHidden as="p" role="status">
        {wait && !said ? (wait.retryAt === null ? "Det går fortfarande inte att skicka." : "Det gick inte att skicka just nu. Försöker igen automatiskt.") : ""}
      </VisuallyHidden>
      {wait && (
        <HStack gap={3} wrap="wrap" align="center" justify="between">
          {/* Tabular figures and the unit kept with its number: the counting seconds do not shake the line. Body text: it
              says what happens to the person's file. */}
          <Text as="p" hasTabularNumbers>
            {said ? "" : wait.retryAt === null ? "Det går fortfarande inte att skicka. " : "Det gick inte att skicka just nu. "}
            {wait.retryAt === null ? "Försök igen när du vill." : `Försöker igen om ${seconds}\u00a0s.`}
          </Text>
          <Button
            label={wait.retryAt === null ? "Försök igen" : "Försök nu"}
            size="sm"
            onClick={() => {
              pressed.current = true;
              wait.retryNow();
            }}
          />
        </HStack>
      )}
    </VStack>
  );
}
