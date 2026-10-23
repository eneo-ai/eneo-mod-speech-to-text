/** Whether the person asked for less motion: what moves by itself then jumps. */
export function prefersReducedMotion(): boolean {
  return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** How a scroll the page makes by itself moves. */
export const scrollBehavior = (): ScrollBehavior => (prefersReducedMotion() ? "instant" : "smooth");

/**
 * How a scroll the page makes by itself over `distance` moves in a box `viewport` high: a glide for a step or two, a
 * jump for a distance a glide would only blur (a browser glides up to 1.5 s over thousands of pixels).
 */
export const scrollBehaviorFor = (distance: number, viewport: number): ScrollBehavior =>
  Math.abs(distance) > viewport * 1.5 ? "instant" : scrollBehavior();
