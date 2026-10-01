"use client";

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
    <VStack gap={3}>
      <VisuallyHidden as="p" role="status">
        {wait ? "Det gick inte att skicka just nu. Försöker igen automatiskt." : ""}
      </VisuallyHidden>
      {wait && (
        <HStack gap={3} wrap="wrap" align="center" justify="between">
          <Text as="p" type="supporting">
            Det gick inte att skicka just nu. Försöker igen om {seconds} s.
          </Text>
          <Button label="Försök nu" size="sm" onClick={wait.retryNow} />
        </HStack>
      )}
    </VStack>
  );
}
