import { CheckCircle2, Circle, CircleDashed, CircleDot, MinusCircle, XCircle, type LucideIcon } from "lucide-react";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { stepStateLabel, type StepState, type StepView } from "@/lib/run-progress";

const ICONS: Record<StepState, [LucideIcon, "success" | "accent" | "secondary" | "error"]> = {
  done: [CheckCircle2, "success"],
  // Static: the stage line above already shows that something is moving.
  running: [CircleDot, "accent"],
  waiting: [Circle, "secondary"],
  failed: [XCircle, "error"],
  cancelled: [MinusCircle, "secondary"],
  not_run: [CircleDashed, "secondary"],
};

/** Each step with its state in words; the icon only repeats the word. */
export function StepList({ steps }: { steps: readonly StepView[] }) {
  return (
    // role="list": a list the reset has stripped of its bullets keeps its list semantics in Safari.
    <VStack as="ol" role="list" gap={4}>
      {steps.map((step) => {
        const [glyph, color] = ICONS[step.state];
        return (
          <HStack as="li" key={step.order} gap={3} align="start">
            <Icon icon={glyph} size="md" color={color} />
            <StackItem size="fill">
              <VStack gap={0.5}>
                <HStack wrap="wrap" justify="between" gap={2}>
                  <Text weight={step.state === "running" ? "semibold" : undefined}>{step.label}</Text>
                  <Text type="supporting">{stepStateLabel(step.state)}</Text>
                </HStack>
                {step.note && <Text type="supporting">{step.note}</Text>}
              </VStack>
            </StackItem>
          </HStack>
        );
      })}
    </VStack>
  );
}
