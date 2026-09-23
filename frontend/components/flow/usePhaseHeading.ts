"use client";

import { useEffect, useRef } from "react";

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
