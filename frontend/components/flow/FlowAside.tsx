"use client";

import { ChevronDown } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { BackToFlows } from "@/components/flow/BackToFlows";
import { ClassificationNote } from "@/components/flow/ClassificationNote";
import type { FlowPublished, FlowSecurityClassification } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * A flow's page, its first column: the way back, the flow's name and description, and its details. The same
 * in every state, so only the working card beside it changes. Compact (audio held, a run under way), the
 * description is for laptops only and the details fold into one line on a phone or tablet, keeping the card
 * near the top.
 */
export function FlowAside({
  published,
  classification,
  titleIsHeading = true,
  onLeave,
  locked = false,
  compact = false,
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
  onLeave?: (event: MouseEvent) => void;
  /** No way back while leaving would abort an upload; its place is kept, so the flow's name does not move. */
  locked?: boolean;
  compact?: boolean;
  details: ReactNode;
  /** The details in one line, for the fold; none, no fold. */
  summary?: string | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  const Title = titleIsHeading ? "h1" : "p";
  return (
    <div className={cn("flex flex-col gap-5", className)}>
      {locked ? (
        <span aria-hidden className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "invisible hidden w-fit lg:inline-flex")} />
      ) : (
        <BackToFlows onLeave={onLeave} className="hidden lg:inline-flex" />
      )}
      <Title className="hidden text-[26px] font-semibold leading-tight tracking-[-0.02em] text-ink [text-wrap:balance] lg:block">
        {published.name}
      </Title>
      <div className={cn("flex flex-col gap-5", compact && "hidden lg:flex")}>
        {published.description && <p className="max-w-prose text-[17px] leading-relaxed text-ink-soft">{published.description}</p>}
        <ClassificationNote classification={classification} />
      </div>
      {compact && summary ? (
        <Collapsible open={open} onOpenChange={onOpenChange}>
          <CollapsibleTrigger className="group flex min-h-12 w-full items-center gap-3 rounded-xl border border-rule-soft bg-paper px-4 text-left text-[15px] text-ink transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary lg:hidden">
            <span className="min-w-0 flex-1 truncate">
              <span className="sr-only">Uppgifter, </span>
              {summary}
            </span>
            <ChevronDown
              aria-hidden
              className="size-5 shrink-0 text-ink-soft transition-transform duration-150 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
            />
          </CollapsibleTrigger>
          <CollapsibleContent forceMount className="pt-4 data-[state=closed]:max-lg:hidden lg:pt-0">
            {details}
          </CollapsibleContent>
        </Collapsible>
      ) : (
        details
      )}
    </div>
  );
}
