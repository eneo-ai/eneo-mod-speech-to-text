import { useState } from "react";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Section } from "@astryxdesign/core/Section";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { StepView } from "@/lib/run-progress";
import { StepList } from "./StepList";

/**
 * How the result was made, folded away: the flow's steps, in words a reader
 * knows, and the flow version, which belongs here and not in the headline.
 */
export function StepDetails({ steps, version }: { steps: readonly StepView[]; version?: number }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  return (
    // Controlled: left alone, a Collapsible starts open.
    <Collapsible
      isOpen={open}
      onOpenChange={setOpen}
      trigger={
        <>
          {open ? "Dölj hur resultatet togs fram" : "Hur resultatet togs fram"} <Text type="supporting">{steps.length} steg</Text>
        </>
      }
    >
      <Section>
        <VStack gap={4}>
          <StepList steps={steps} />
          {version != null && (
            <Text as="p" type="supporting">
              Flödets version {version}
            </Text>
          )}
        </VStack>
      </Section>
    </Collapsible>
  );
}
