import type { ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { BackToFlows } from "@/components/flow/BackToFlows";
import { ClassificationNote } from "@/components/flow/ClassificationNote";
import type { FlowPublished, FlowSecurityClassification } from "@/lib/api";
import styles from "./FlowFrame.module.css";

/**
 * A flow's page, its first column: the way back, the flow's name and description, and its details. The same
 * in every state, so only the working card beside it changes. Compact (audio held, a run under way), the
 * description is for laptops only and the details fold into one line on a phone or tablet, keeping the card
 * near the top. The flow's name is here on every width: the top bar holds only the way back and the account.
 */
export function FlowAside({
  published,
  classification,
  titleIsHeading = true,
  locked = false,
  compact = false,
  details,
  summary,
  open,
  onOpenChange,
  className,
}: {
  published: FlowPublished;
  classification?: FlowSecurityClassification | null;
  /** False where the state's card has the page's heading. */
  titleIsHeading?: boolean;
  /** No way back while leaving would abort an upload; its place is kept, so the flow's name does not move. */
  locked?: boolean;
  compact?: boolean;
  details: ReactNode;
  /** The details in one line, for the fold; none, no fold. */
  summary?: string | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  return (
    <VStack gap={5} className={className}>
      <HStack className={styles.fromLaptop}>
        {locked ? (
          <span aria-hidden className={styles.reserve}>
            <Button label="Alla flöden" size="sm" />
          </span>
        ) : (
          <BackToFlows />
        )}
      </HStack>
      {titleIsHeading ? (
        <Heading level={1} className={compact ? styles.compactName : undefined}>
          {published.name}
        </Heading>
      ) : (
        <Text as="p" weight="semibold" type="large">
          {published.name}
        </Text>
      )}
      <VStack gap={5} className={compact ? styles.fromLaptop : undefined}>
        {published.description && <Text as="p" color="secondary">{published.description}</Text>}
        <ClassificationNote classification={classification} />
      </VStack>
      {compact && summary ? (
        <Collapsible
          className={styles.fold}
          isOpen={open}
          onOpenChange={onOpenChange}
          trigger={
            <>
              <VisuallyHidden>Uppgifter, </VisuallyHidden>
              {summary}
            </>
          }
        >
          {details}
        </Collapsible>
      ) : (
        details
      )}
    </VStack>
  );
}
