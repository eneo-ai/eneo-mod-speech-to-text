import type { ReactNode } from "react";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { ClassificationNote } from "@/components/flow/ClassificationNote";
import { HowItWorks } from "@/components/flow/HowItWorks";
import type { FlowPublished, FlowSecurityClassification } from "@/lib/api";
import type { HowItWorks as Guide } from "@/lib/flow-output";
import styles from "./FlowFrame.module.css";

/** A small phone's window (320 × 568): the first screen has the ways in and what the chosen one does above the dock. */
const SHORT_PHONE = "(max-width: 767.98px) and (max-height: 640px)";
const COLUMNS = "(min-width: 1024px)";

/**
 * A flow's page, its first column: the flow's name and description, and its details. The same in every state, so
 * only the working card beside it changes. Compact (audio held, a run under way), the description is for laptops
 * only and the details fold into one line on a phone or tablet, keeping the card near the top. The flow's name is
 * here on every width: the top bar holds the way back and the account.
 */
export function FlowAside({
  published,
  classification,
  titleIsHeading = true,
  compact = false,
  described = true,
  lead,
  guide = null,
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
  compact?: boolean;
  /** False where the description is said elsewhere (a phone's setup, in "Så fungerar det" after the work). */
  described?: boolean;
  /** What comes first under the flow's name: a recording to go on with in one column, the way to the earlier runs beside the work. */
  lead?: ReactNode;
  /** "Så fungerar det", where the page asks for the audio (the setup); none while the page holds audio or a run. */
  guide?: Guide | null;
  details: ReactNode;
  /** The details in one line, for the fold; none, no fold. */
  summary?: string | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  // The name, its description and Så fungerar det stand closer on a small phone, so what streaming sends is in view, and
  // so do the name and the details' folded row over a compact page's card in one column, a label and its summary; the
  // column's parts stand 32 px apart beside the work.
  const short = useMediaQuery(SHORT_PHONE, true);
  const columns = useMediaQuery(COLUMNS, true);
  const gap = short || (compact && !columns) ? 3 : columns ? 8 : 6;
  // The flow's name is the page's arrival title, and its description the lead under it: for laptops only while the page
  // holds audio or a run.
  const description = described && published.description && (
    // At the body's size on a small phone, so the ways in reach the first screen above the dock.
    <Text as="p" type={short ? "body" : "large"} weight="normal" color="secondary" className={compact ? styles.fromLaptop : undefined}>
      {published.description}
    </Text>
  );
  return (
    <VStack gap={gap} className={className}>
      <VStack gap={3}>
        {titleIsHeading ? (
          <Heading level={1} type="display-3" className={compact ? styles.compactName : styles.name}>
            {published.name}
          </Heading>
        ) : (
          // Where a run's card has the page's heading the name is no heading, but it looks as it does in the setup, so the
          // column does not change when a run starts.
          <Text as="p" type="display-3" textWrap="balance" className={[styles.columnName, compact && styles.compactName].filter(Boolean).join(" ")}>
            {published.name}
          </Text>
        )}
        {description}
      </VStack>
      {lead}
      {(guide || classification) && (
        <VStack gap={gap} className={compact ? styles.fromLaptop : undefined}>
          {guide && <HowItWorks guide={guide} />}
          <ClassificationNote classification={classification} />
        </VStack>
      )}
      {compact && summary ? (
        <Collapsible
          className={styles.fold}
          isOpen={open}
          onOpenChange={onOpenChange}
          // The row says what it is ("Uppgifter"), then what is filled in: bordered as a field is, it is no picker. Its
          // name is "Uppgifter, Deltagare: …", the word heard once.
          trigger={
            <>
              <Text type="supporting" color="secondary" aria-hidden>
                Uppgifter
              </Text>{" "}
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
