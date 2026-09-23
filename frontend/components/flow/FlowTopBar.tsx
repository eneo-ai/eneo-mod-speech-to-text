"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";
import { AccountMenu } from "@/components/AccountMenu";
import { Brand } from "@/components/Brand";

/**
 * Phone and tablet: back, the flow's name as the page heading, and the
 * account (or, while recording, the mode). Laptop: the app's header, with the
 * flow's name heading the details column instead.
 */
export function FlowTopBar({
  title,
  trailing,
  onLeave,
}: {
  title: string;
  /** Replaces the account menu, e.g. with the mode while recording. */
  trailing?: ReactNode;
  /** Asked before a link leaves the page; call preventDefault to stay. */
  onLeave?: (event: MouseEvent) => void;
}) {
  return (
    <>
      <header className="flex items-center gap-1 px-2 pb-1 pt-2 md:px-6 lg:hidden">
        <Link
          href="/flows"
          aria-label="Till flödena"
          onClick={onLeave}
          className="grid size-11 shrink-0 place-items-center rounded-full text-ink transition-colors hover:bg-bg-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ChevronLeft aria-hidden className="size-6" strokeWidth={2} />
        </Link>
        <h1 className="line-clamp-2 min-w-0 flex-1 text-[19px] font-semibold leading-tight tracking-[-0.01em] text-ink [text-wrap:balance]">
          {title}
        </h1>
        <div className="flex shrink-0 items-center pl-2">{trailing ?? <AccountMenu />}</div>
      </header>
      <header className="hidden items-center justify-between border-b border-rule-soft bg-paper px-8 py-3 lg:flex">
        <div onClickCapture={onLeave}>
          <Brand href="/flows" />
        </div>
        <AccountMenu />
      </header>
    </>
  );
}
