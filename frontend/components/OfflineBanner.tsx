import { WifiOff } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
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
    // The room below it is its own, only while it shows: online the region holds nothing and takes no space.
    <VStack role="status" paddingBlockEnd={online ? undefined : 4}>
      {!online && (
        <Card variant="muted" padding={3}>
          <HStack gap={3} align="start">
            <Icon icon={WifiOff} color="secondary" />
            <Text as="p" type="supporting">
              {waiting ? MESSAGES[waiting] : "Ingen anslutning."}
            </Text>
          </HStack>
        </Card>
      )}
    </VStack>
  );
}
