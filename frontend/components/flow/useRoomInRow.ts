import { useLayoutEffect, useRef, useState } from "react";

const px = (lengths: string[]) => lengths.reduce((sum, length) => sum + (Number.parseFloat(length) || 0), 0);

/** The room inside a row's padding and border: what its children have. */
function innerWidth(row: Element) {
  const style = getComputedStyle(row);
  return row.getBoundingClientRect().width - px([style.paddingInlineStart, style.paddingInlineEnd, style.borderInlineStartWidth, style.borderInlineEndWidth]);
}

/** What a child takes of its row: its box, less a negative margin (a trailing ghost button's padding outside the column). */
function taken(child: Element) {
  const style = getComputedStyle(child);
  return child.getBoundingClientRect().width + Math.min(0, px([style.marginInlineStart])) + Math.min(0, px([style.marginInlineEnd]));
}

/**
 * Whether a row's actions fit on one line, measured before the row is drawn: while they stand in it, their widths and
 * the gaps between them against the room inside the row's padding; while they are folded, the width they took when they
 * last stood in it. A child out of the row's flow (a visually hidden heading) takes none. Measured again whenever the row
 * or one of its actions changes size: a tablet turned, a copy that could not be made, the font arriving. `ref` goes on
 * the row.
 */
export function useRoomInRow() {
  const [row, ref] = useState<HTMLElement | null>(null);
  const [fits, setFits] = useState(true);
  const needs = useRef(0);
  useLayoutEffect(() => {
    if (!row) return;
    const measure = () => {
      if (fits) {
        const actions = [...row.children].filter((child) => getComputedStyle(child).position !== "absolute");
        const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
        needs.current = actions.reduce((sum, action) => sum + taken(action), gap * (actions.length - 1));
      }
      setFits(needs.current <= innerWidth(row));
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    for (const element of [row, ...row.children]) observer.observe(element);
    return () => observer.disconnect();
  }, [row, fits]);
  return { ref, fits };
}

/**
 * Whether a row's actions stand beside the rest of it, which keeps `reserveRem` of the row: the actions' own widths and
 * gaps against what the row leaves. Measured again whenever the row or an action changes size, and when the actions are
 * drawn anew (a window that crosses a breakpoint). `ref` goes on the row, `actionsRef` on the actions.
 */
export function useRoomBeside(reserveRem: number) {
  const [row, ref] = useState<HTMLElement | null>(null);
  const [actions, actionsRef] = useState<HTMLElement | null>(null);
  const [beside, setBeside] = useState(true);
  useLayoutEffect(() => {
    if (!row || !actions) return;
    const measure = () => {
      const style = getComputedStyle(actions);
      const room = px([style.paddingInlineStart, style.paddingInlineEnd]);
      const kids = [...actions.children];
      const needs = kids.reduce((sum, kid) => sum + kid.getBoundingClientRect().width, room + (Number.parseFloat(style.columnGap) || 0) * (kids.length - 1));
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setBeside(needs + reserveRem * rem <= innerWidth(row));
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    for (const element of [row, ...actions.children]) observer.observe(element);
    return () => observer.disconnect();
  }, [row, actions, reserveRem]);
  return { ref, actionsRef, beside };
}
