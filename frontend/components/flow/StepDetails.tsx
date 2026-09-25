"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-3">
      <CollapsibleTrigger asChild>
        {/* The label wraps rather than running off a narrow screen, e.g. with wider letter spacing (WCAG 1.4.12). */}
        <Button variant="ghost" className="group -ml-3 h-auto min-h-9 self-start whitespace-normal px-3 py-1.5 text-left coarse:h-auto coarse:min-h-11">
          <ChevronDown
            data-icon="inline-start"
            aria-hidden
            className="transition-transform duration-150 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
          />
          {open ? "Dölj hur resultatet togs fram" : "Hur resultatet togs fram"}
          <span className="font-normal text-ink-mute">{steps.length} steg</span>
        </Button>
      </CollapsibleTrigger>
      {/* Closed content keeps its element with `hidden`; a display class on it would override that. */}
      <CollapsibleContent>
        <div className="flex flex-col gap-4 rounded-xl border bg-card p-4 md:p-6">
          <StepList steps={steps} />
          {version != null && <p className="text-sm text-muted-foreground">Flödets version {version}</p>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
