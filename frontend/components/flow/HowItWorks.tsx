import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Heading } from "@astryxdesign/core/Heading";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { HowItWorks as Guide } from "@/lib/flow-output";
import styles from "./FlowFrame.module.css";

/**
 * "Så fungerar det": the steps a run of the flow takes the person through (`howItWorks`), and tips for good sound folded
 * under them. From a laptop's width it is always shown under its heading in the flow's column; on a phone or tablet it
 * is one folded row (FlowFrame's fold), so the ways in stay on the first screen.
 */
export function HowItWorks({ guide }: { guide: Guide }) {
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
        <List listStyle="decimal" density="compact">
          {guide.steps.map((step) => (
            <ListItem key={step} label={step} />
          ))}
        </List>
        {guide.tips.length > 0 && (
          <Collapsible trigger="Tips för bra ljud" defaultIsOpen={false}>
            <List listStyle="disc" density="compact">
              {guide.tips.map((tip) => (
                <ListItem key={tip} label={tip} />
              ))}
            </List>
          </Collapsible>
        )}
      </VStack>
    </Collapsible>
  );
}
