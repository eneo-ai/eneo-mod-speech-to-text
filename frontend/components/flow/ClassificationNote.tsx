import { ShieldCheck } from "lucide-react";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { FlowSecurityClassification } from "@/lib/api";

/**
 * What information the flow may take: the classification of the flow's space,
 * its name and description as the organization wrote them. Without one Eneo
 * states no rule, so there is no row.
 */
export function ClassificationNote({ classification }: { classification?: FlowSecurityClassification | null }) {
  if (!classification) return null;
  // A note, not an alert or a status: it is read in its place, never announced.
  return (
    <Card role="note" padding={4}>
      <HStack gap={3} align="start">
        <Icon icon={ShieldCheck} />
        <VStack gap={1}>
          <Text weight="semibold">{classification.name}</Text>
          {classification.description && <Text color="secondary">{classification.description}</Text>}
        </VStack>
      </HStack>
    </Card>
  );
}
