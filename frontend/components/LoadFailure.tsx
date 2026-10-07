import type { ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";

/**
 * What a page says where lazily loaded code could not be fetched (a tab older than the deploy that replaced its files,
 * a connection that dropped): what happened, and one action, the person's own reload. A browser keeps a failed fetch of
 * a module per address, so a second import() of it makes no request and could not recover; nothing reloads by itself,
 * since the page may hold work. `keeps` says what a reload gives back, only where it does.
 */
export function LoadFailure({ children, keeps, reload = () => window.location.reload() }: { children: ReactNode; keeps?: string; reload?: () => void }) {
  return (
    <HStack vAlign="center" wrap="wrap" gap={2}>
      <Text as="p" type="supporting" role="status">
        {children}
        {keeps ? ` ${keeps}` : null}
      </Text>
      <Button size="sm" label="Ladda om sidan" onClick={() => reload()} />
    </HStack>
  );
}
