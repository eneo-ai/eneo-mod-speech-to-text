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

/**
 * The classification once more where the person commits, above the setup's primary action (docked with it on a phone):
 * one line, the name only. The card with the organisation's description stays with the flow.
 */
export function ClassificationLine({ classification }: { classification?: FlowSecurityClassification | null }) {
  if (!classification) return null;
  return (
    <HStack gap={2} hAlign="center" vAlign="center" wrap="wrap">
      <Icon icon={ShieldCheck} />
      <Text type="supporting">Flödet får ta emot:</Text>
      <Text type="supporting" weight="semibold" color="primary">
        {classification.name}
      </Text>
    </HStack>
  );
}
