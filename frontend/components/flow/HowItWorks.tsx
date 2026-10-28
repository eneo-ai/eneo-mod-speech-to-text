import type { ReactNode } from "react";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { HowItWorks as Guide } from "@/lib/flow-output";
import styles from "./FlowFrame.module.css";

/**
 * "Så fungerar det": the steps a run of the flow takes the person through (`howItWorks`). From a laptop's width it is
 * always shown under its heading in the flow's column; on a phone or tablet it is one folded row (FlowFrame's fold) above
 * the choice of way in, where it is read before the meeting, not after the form (after it on a short screen, whose first
 * screen is the ways in's; FlowInput). `lead` opens the fold (a phone's setup
 * has the flow's description there, read once, rather than above the choice). The tips for good sound are the
 * microphone's (MicrophoneCheck).
 */
export function HowItWorks({ guide, lead }: { guide: Guide; lead?: ReactNode }) {
  return (
    <Collapsible
      className={styles.fold}
      defaultIsOpen={false}
      trigger={
        <>
          Så fungerar det <Text type="supporting">{guide.steps.length} steg</Text>
        </>
      }
    >
      <VStack as="section" aria-labelledby="how-it-works" gap={3}>
        {/* The folded row names it below a laptop's width; from it, where the row is gone, the heading does. */}
        <Heading level={2} id="how-it-works" className={styles.fromLaptop}>
          Så fungerar det
        </Heading>
        {lead}
        {/* Native lists, so a long step wraps in the 20rem column and on a phone; Astryx's list item keeps one line. */}
        <VStack as="ol" gap={2} className={styles.steps}>
          {guide.steps.map((step) => (
            <li key={step}>
              <Text>{step}</Text>
            </li>
          ))}
        </VStack>
      </VStack>
    </Collapsible>
  );
}
