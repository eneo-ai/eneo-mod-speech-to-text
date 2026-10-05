/** Whether the person asked for less motion: what moves by itself then jumps. */
export function prefersReducedMotion(): boolean {
  return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** How a scroll the page makes by itself moves. */
export const scrollBehavior = (): ScrollBehavior => (prefersReducedMotion() ? "instant" : "smooth");
