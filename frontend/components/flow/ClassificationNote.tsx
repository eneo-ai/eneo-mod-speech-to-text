import { ShieldCheck } from "lucide-react";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { IconTile } from "@/components/IconTile";
import type { FlowSecurityClassification } from "@/lib/api";

/**
 * What information the flow may take: the classification of the flow's space,
 * its name and description as the organization wrote them. Without one Eneo
 * states no rule, so there is no row. A card of its own in the flow's column; `bare`
 * inside the working card, which is no place for a card in a card.
 */
export function ClassificationNote({ classification, bare = false }: { classification?: FlowSecurityClassification | null; bare?: boolean }) {
  if (!classification) return null;
  // A note, not an alert or a status: it is read in its place, never announced. Its tile is in the deployment's colour.
  const note = (
    <HStack gap={3} align="start" role={bare ? "note" : undefined}>
      <IconTile icon={ShieldCheck} size="sm" />
      <VStack gap={1}>
        <Text weight="semibold">{classification.name}</Text>
        {classification.description && <Text color="secondary">{classification.description}</Text>}
      </VStack>
    </HStack>
  );
  return bare ? (
    note
  ) : (
    <Card role="note" padding={5}>
      {note}
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
      <Icon icon={ShieldCheck} size="sm" color="secondary" />
      {/* The supporting size: one line in a 320 px phone's dock. */}
      <Text type="supporting" color="secondary">
        Flödet får ta emot:
      </Text>
      <Text type="supporting" weight="semibold" color="primary">
        {classification.name}
      </Text>
    </HStack>
  );
}
