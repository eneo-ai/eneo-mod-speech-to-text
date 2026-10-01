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
  start,
  end,
  banner,
  height = "auto",
  children,
}: {
  /** The navigation landmark's name. */
  label: string;
  /** The brand, or on a flow's page the way back and the flow's name. */
  heading: ReactNode;
  /** After the heading, where a long text may wrap: the heading's own place never shrinks. */
  start?: ReactNode;
  /** The account menu, or what a page shows in its place. */
  end?: ReactNode;
  /** A notice for the whole page, above the bar. */
  banner?: ReactNode;
  /**
   * "auto": the page grows and the window scrolls, the bar with it (app/globals.css lets it scroll away). "fill": the
   * shell is the window's height, the bar stays and the main region scrolls itself, for a page whose panes scroll on
   * their own (a recording).
   */
  height?: "auto" | "fill";
  children: ReactNode;
}) {
  // "surface": the page is one colour from the bar to the window's end. The default ("elevated") ends the surface at
  // the content's height, so a short page (the sign-in) shows a band of the wash colour below it.
  return (
    <AppShell
      height={height}
      variant="surface"
      mobileNav={false}
      // A page that fills the window owns its edges, so a bar stuck to the region's bottom is flush with the window.
      contentPadding={height === "fill" ? 0 : 4}
      banner={banner}
      topNav={<TopNav label={label} heading={heading} startContent={start} endContent={end} />}
    >
      {children}
    </AppShell>
  );
}
