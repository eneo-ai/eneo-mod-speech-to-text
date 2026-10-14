import { CheckCircle2, Circle, CircleDashed, MinusCircle, XCircle, type LucideIcon } from "lucide-react";
import { Icon } from "@astryxdesign/core/Icon";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Step, Stepper } from "@astryxdesign/core/Stepper";
import { Text } from "@astryxdesign/core/Text";
import { stepStateLabel, type StepState, type StepView } from "@/lib/run-progress";

// The step under way has the design system's spinner instead: what shows that Eneo is working, and it stands still with
// reduced motion (styles/globals.css).
const ICONS: Record<Exclude<StepState, "running">, [LucideIcon, "success" | "secondary" | "error"]> = {
  done: [CheckCircle2, "success"],
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
        const indicator =
          step.state === "running" ? <Spinner size="sm" /> : <Icon icon={ICONS[step.state][0]} size="sm" color={ICONS[step.state][1]} />;
        return (
          <Step
            key={step.order}
            step={index}
            label={step.label}
            description={step.note ?? undefined}
            indicator={indicator}
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
