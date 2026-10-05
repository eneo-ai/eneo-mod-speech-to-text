import { CheckCircle2, Circle, CircleDashed, CircleDot, MinusCircle, XCircle, type LucideIcon } from "lucide-react";
import { Icon } from "@astryxdesign/core/Icon";
import { Step, Stepper } from "@astryxdesign/core/Stepper";
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

/**
 * Each step with its state in words; the icon only repeats the word. The current step is the first that is not done:
 * the one that runs, waits, or stopped the run. The design system says a finished step is "slutfört" to a screen
 * reader, so the page's "Klar" is for the eye.
 */
export function StepList({ steps }: { steps: readonly StepView[] }) {
  const current = steps.findIndex((step) => step.state !== "done");
  return (
    // role="list": a list the reset has stripped of its bullets keeps its list semantics in Safari.
    <Stepper orientation="vertical" activeStep={current === -1 ? steps.length : current} label="Flödets steg" role="list">
      {steps.map((step, index) => {
        const [glyph, color] = ICONS[step.state];
        return (
          <Step
            key={step.order}
            step={index}
            label={step.label}
            description={step.note ?? undefined}
            indicator={<Icon icon={glyph} size="sm" color={color} />}
            endContent={
              <Text type="supporting" textWrap="nowrap" aria-hidden={step.state === "done" || undefined}>
                {stepStateLabel(step.state)}
              </Text>
            }
          />
        );
      })}
    </Stepper>
  );
}
