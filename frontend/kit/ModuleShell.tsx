"use client";

import type { ReactNode } from "react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { TopNav } from "@astryxdesign/core/TopNav";

/**
 * A page's frame: the top bar, the skip link and the main region. It holds no state and decides nothing: the route
 * that renders it says what the bar shows, so a page that must not be left (a recording, a sending) leaves the
 * account and the way back out.
 */
export function ModuleShell({
  label,
  heading,
  end,
  banner,
  children,
}: {
  /** The navigation landmark's name. */
  label: string;
  /** The brand, or on a flow's page the way back and the flow's name. */
  heading: ReactNode;
  /** The account menu, or what a page shows in its place. */
  end?: ReactNode;
  /** A notice for the whole page, above the bar. */
  banner?: ReactNode;
  children: ReactNode;
}) {
  return (
    <AppShell height="auto" mobileNav={false} contentPadding={4} banner={banner} topNav={<TopNav label={label} heading={heading} endContent={end} />}>
      {children}
    </AppShell>
  );
}
