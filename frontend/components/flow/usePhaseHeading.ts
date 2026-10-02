"use client";

import { useEffect, useRef } from "react";
import { useDocumentTitle } from "./recording-hooks";

/**
 * A phase's view announces itself: the tab title names the state, and focus
 * moves to the view's heading when the view appears, never on later updates.
 * The heading is no control (tabIndex -1) and draws no ring (the theme's rule).
 */
export function usePhaseHeading(title: string) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  useDocumentTitle(`${title} · Tal till text`);
  return heading;
}
