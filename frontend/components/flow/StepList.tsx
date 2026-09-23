import {
  CheckCircle2,
  Circle,
  CircleDashed,
  Loader2,
  MinusCircle,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { stepStateLabel, type StepState, type StepView } from "@/lib/run-progress";

const ICONS: Record<StepState, [LucideIcon, string]> = {
  done: [CheckCircle2, "text-ok"],
  running: [Loader2, "text-primary animate-spin motion-reduce:animate-none"],
  waiting: [Circle, "text-muted-foreground"],
  failed: [XCircle, "text-destructive"],
  cancelled: [MinusCircle, "text-muted-foreground"],
  not_run: [CircleDashed, "text-muted-foreground"],
};

/** Each step with its state in words; the icon only repeats the word. */
export function StepList({ steps }: { steps: readonly StepView[] }) {
  return (
    <ol className="flex flex-col gap-4">
      {steps.map((step) => {
        const [Icon, tone] = ICONS[step.state];
        return (
          <li key={step.order} className="flex items-start gap-3">
            <Icon aria-hidden className={cn("mt-0.5 size-5 shrink-0", tone)} />
            <div className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
              <span className={cn("text-[15px] leading-snug", step.state === "running" && "font-semibold")}>
                {step.label}
              </span>
              <span className="text-sm text-muted-foreground">{stepStateLabel(step.state)}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
