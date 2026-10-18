import { useLayoutEffect, useRef, useState } from "react";

/**
 * Whether a row's actions fit on one line, measured before the row is drawn: while they stand in it, their widths and
 * the gaps between them against the row's width; while they are folded, the width they took when they last stood in it.
 * Measured again whenever the row or one of its actions changes size: a tablet turned, a copy that could not be made, the
 * font arriving. `ref` goes on the row.
 */
export function useRoomInRow() {
  const [row, ref] = useState<HTMLElement | null>(null);
  const [fits, setFits] = useState(true);
  const needs = useRef(0);
  useLayoutEffect(() => {
    if (!row) return;
    const measure = () => {
      if (fits) {
        const actions = [...row.children];
        const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
        needs.current = actions.reduce((sum, action) => sum + action.getBoundingClientRect().width, gap * (actions.length - 1));
      }
      setFits(needs.current <= row.getBoundingClientRect().width);
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    for (const element of [row, ...row.children]) observer.observe(element);
    return () => observer.disconnect();
  }, [row, fits]);
  return { ref, fits };
}
