"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useContext, type MouseEvent, type ReactNode } from "react";
import { AccountMenu } from "@/components/AccountMenu";
import { Brand } from "@/components/Brand";
import { LeaveContext } from "@/components/flow/useLeaveQuestion";
import { FRAME } from "@/components/frame";
import { cn } from "@/lib/utils";

/**
 * The app's header on the old frame, for the pages not yet on the shell (the flow list, until Phase 2, and this
 * bar's laptop width, until Phase 3): from laptops a band across the window, its brand on the frame's left edge.
 */
export function LegacyAppHeader({
  onLeave,
  account = true,
  linked = account,
  className,
}: {
  /** Asked before the brand's link leaves the page; call preventDefault to stay. */
  onLeave?: (event: MouseEvent) => void;
  /** False before sign-in, and while the page shows something else in its place. */
  account?: boolean;
  /** Whether the brand links to the flows; not before sign-in, nor while leaving would abort an upload. */
  linked?: boolean;
  className?: string;
}) {
  return (
    <header className={cn("lg:border-b lg:border-rule-soft lg:bg-paper", className)}>
      <div className={cn(FRAME, "flex min-h-16 items-center justify-between pb-6 pt-5 md:pt-7 lg:py-3")}>
        <div onClickCapture={onLeave}>
          <Brand href={linked ? "/flows" : undefined} />
        </div>
        {account && <AccountMenu />}
      </div>
    </header>
  );
}

/**
 * Phone and tablet: back, the flow's name as the page heading, and the
 * account (or, while recording, the mode). Laptop: the app's header, with the
 * flow's name heading the details column instead. Locked, it offers no way off
 * the page at all.
 */
export function FlowTopBar({
  title,
  trailing,
  onLeave,
  titleIsHeading = true,
  locked = false,
}: {
  title: string;
  /** Replaces the account menu on every width, e.g. with the mode while recording, which signing out would drop. */
  trailing?: ReactNode;
  /** Asked before a link leaves the page; call preventDefault to stay. */
  onLeave?: (event: MouseEvent) => void;
  /** False where the view's own heading names its state, as a run's views do. */
  titleIsHeading?: boolean;
  /** While leaving would abort what the view is doing (an upload under way): the view's own way out is the only one. */
  locked?: boolean;
}) {
  const Title = titleIsHeading ? "h1" : "p";
  // The page's leave question, unless the view asks itself.
  const leave = useContext(LeaveContext);
  const onLeaveLink = onLeave ?? leave.onLeave;
  const account = !locked && trailing === undefined;
  return (
    <>
      <header className={cn("flex min-h-14 items-center gap-1 px-2 pb-1 pt-2 md:px-6 lg:hidden", locked && "pl-4 md:pl-8")}>
        {!locked && (
          // A 44 px target showing a soft 40 px button, the size of the account's round one on the other side.
          <Link
            href="/flows"
            aria-label="Alla flöden"
            onClick={onLeaveLink}
            className="group grid size-11 shrink-0 place-items-center rounded-full text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span className="grid size-10 place-items-center rounded-full bg-bg-2 transition-colors group-hover:bg-rule-soft group-active:bg-rule-soft">
              <ChevronLeft aria-hidden className="size-6" strokeWidth={2.25} />
            </span>
          </Link>
        )}
        {/* Every word of the name, however many lines it takes: a clamped heading loses words nothing else says. */}
        <Title className="min-w-0 flex-1 text-[19px] font-semibold leading-tight tracking-[-0.01em] text-ink [overflow-wrap:anywhere] [text-wrap:balance]">
          {title}
        </Title>
        <div className="flex shrink-0 items-center pl-2">{trailing ?? (account && <AccountMenu />)}</div>
      </header>
      <LegacyAppHeader onLeave={onLeaveLink} account={account} linked={!locked} className="hidden lg:block" />
    </>
  );
}
