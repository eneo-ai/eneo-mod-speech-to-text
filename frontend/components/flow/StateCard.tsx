import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** The heading of a state's card, which takes focus when the state appears. */
export const STATE_HEADING = "text-[22px] font-semibold tracking-[-0.01em] text-ink outline-none";

/**
 * The card a flow's page shows a state in, beside the flow (ready, sending, running, failed): one state
 * replaces another in the same place.
 */
export function StateCard({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn("flex flex-col gap-6 rounded-xl border border-rule-soft bg-paper p-5 md:p-6", className)} />;
}
