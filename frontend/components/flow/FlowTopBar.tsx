"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";
import { AccountMenu } from "@/components/AccountMenu";
import { AppHeader } from "@/components/AppHeader";
import { cn } from "@/lib/utils";

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
  const account = !locked && trailing === undefined;
  return (
    <>
      <header className={cn("flex min-h-14 items-center gap-1 px-2 pb-1 pt-2 md:px-6 lg:hidden", locked && "pl-4 md:pl-8")}>
        {!locked && (
          <Link
            href="/flows"
            aria-label="Alla flöden"
            onClick={onLeave}
            className="grid size-11 shrink-0 place-items-center rounded-full text-ink transition-colors hover:bg-bg-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <ChevronLeft aria-hidden className="size-6" strokeWidth={2} />
          </Link>
        )}
        <Title className="line-clamp-2 min-w-0 flex-1 text-[19px] font-semibold leading-tight tracking-[-0.01em] text-ink [text-wrap:balance]">
          {title}
        </Title>
        <div className="flex shrink-0 items-center pl-2">{trailing ?? (account && <AccountMenu />)}</div>
      </header>
      <AppHeader onLeave={onLeave} account={account} linked={!locked} className="hidden lg:block" />
    </>
  );
}
