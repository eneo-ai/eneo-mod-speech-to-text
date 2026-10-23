import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import type { RetryWait } from "@/lib/submit-run";

/**
 * Shown while a send waits to try again. The countdown stays outside the live
 * region, so a screen reader hears one sentence rather than every second.
 */
export function RetryNotice({ wait, onRetried }: { wait: RetryWait | null; /** Where the focus goes when the pressed button goes with the try. */ onRetried?: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!wait) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [wait]);
  const seconds = wait?.retryAt != null ? Math.max(0, Math.ceil((wait.retryAt - now) / 1_000)) : 0;

  return (
    <VStack gap={3}>
      <VisuallyHidden as="p" role="status">
        {wait ? (wait.retryAt === null ? "Det går fortfarande inte att skicka." : "Det gick inte att skicka just nu. Försöker igen automatiskt.") : ""}
      </VisuallyHidden>
      {wait && (
        <HStack gap={3} wrap="wrap" align="center" justify="between">
          {/* Tabular figures and the unit kept with its number: the counting seconds do not shake the line. */}
          <Text as="p" type="supporting" hasTabularNumbers>
            {wait.retryAt === null
              ? "Det går fortfarande inte att skicka. Försök igen när du vill."
              : `Det gick inte att skicka just nu. Försöker igen om ${seconds}\u00a0s.`}
          </Text>
          {/* It goes as the try begins: the focus it had goes where the view says (its heading), not to the page's body. */}
          <Button
            label={wait.retryAt === null ? "Försök igen" : "Försök nu"}
            size="sm"
            onClick={(event) => {
              const focused = document.activeElement === event.currentTarget;
              wait.retryNow();
              if (focused) onRetried?.();
            }}
          />
        </HStack>
      )}
    </VStack>
  );
}
