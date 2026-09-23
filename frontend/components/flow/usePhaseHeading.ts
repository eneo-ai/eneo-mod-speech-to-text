"use client";

import { useEffect, useRef } from "react";

/**
 * The heading a phase's view focuses so a screen reader starts there. It is not
 * a control (tabIndex -1), so it draws no ring: a browser counts the focus call
 * as keyboard focus and would frame the headline on every visit.
 */
export const PHASE_HEADING =
  "text-balance text-[26px] font-semibold leading-tight tracking-[-0.02em] outline-none md:text-[30px]";

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
