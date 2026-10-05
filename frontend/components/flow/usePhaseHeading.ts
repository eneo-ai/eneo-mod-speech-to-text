import { useEffect, useRef } from "react";
import { useDocumentTitle } from "./recording-hooks";
import { documentTitle } from "@/lib/product";

/** What takes the focus when a page or a phase appears: the phase's heading, or an h1 made focusable for it. */
export const PHASE_HEADING = "[data-phase-heading], h1[tabindex]";

/**
 * A phase's view announces itself: the tab title names the state, and focus
 * moves to the view's heading when the view appears, never on later updates.
 * The heading is no control (tabIndex -1) and draws no ring (the theme's rule).
 */
export function usePhaseHeading(title: string) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  useDocumentTitle(documentTitle(title));
  return heading;
}
