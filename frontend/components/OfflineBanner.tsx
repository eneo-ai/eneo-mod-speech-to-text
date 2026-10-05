import { ServerOff, WifiOff } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { onlineStatus, type Connection, type OnlineStatus } from "@/lib/online-status";

function useConnection(status: OnlineStatus): Connection {
  return useSyncExternalStore(status.subscribe, () => status.connection, () => "online");
}

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
 * Says what waits while the device has no network or the module does not answer. The status region is always
 * rendered, so a screen reader announces the change once.
 */
export function OfflineBanner({ waiting, status = onlineStatus }: { waiting: OfflineWaiting; status?: OnlineStatus }) {
  const connection = useConnection(status);
  return (
    // The room below it is its own, only while it shows: online the region holds nothing and takes no space.
    <VStack role="status" paddingBlockEnd={connection === "online" ? undefined : 4}>
      {connection !== "online" && (
        <Card variant="muted" padding={3}>
          <HStack gap={3} align="start">
            <Icon icon={connection === "offline" ? WifiOff : ServerOff} color="secondary" />
            <Text as="p" type="supporting">
              {MESSAGES[connection][waiting ?? "nothing"]}
            </Text>
          </HStack>
        </Card>
      )}
    </VStack>
  );
}
