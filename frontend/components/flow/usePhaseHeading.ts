"use client";

import { useEffect, useRef } from "react";

/** The heading a phase's view focuses; the ring shows when focus came from the keyboard. */
export const PHASE_HEADING =
  "rounded-sm text-balance text-[26px] font-semibold leading-tight tracking-[-0.02em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background md:text-[30px]";

/**
 * A phase's view announces itself: the tab title names the state, and focus
 * moves to the view's heading when the view appears, never on later updates.
 */
export function usePhaseHeading(title: string) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} · Tal till text`;
    return () => {
      document.title = previous;
    };
  }, [title]);
  return heading;
}
