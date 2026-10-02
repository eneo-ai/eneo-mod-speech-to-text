import { useEffect, useState } from "react";

/**
 * What is docked at the bottom of a phone's window (the setup's primary action, a player) covers the page's last rows,
 * so a control that takes focus must scroll to above it (WCAG 2.4.11). Its height is not a number to write down: its
 * words, a longer note and the text spacing a reader may set all change it. Each dock reports its own, and the page
 * keeps the tallest in `--dock-block-size` on <html>, which app/globals.css reads as the scroll padding.
 */
const docks = new Map<HTMLElement, number>();

function publish() {
  const tallest = Math.max(0, ...docks.values());
  const root = document.documentElement.style;
  if (tallest > 0) root.setProperty("--dock-block-size", `${tallest}px`);
  else root.removeProperty("--dock-block-size");
}

/** Keeps a dock's height in `--dock-block-size` while it is on the page and covers it (stuck to the window's edge). */
export function observeDock(dock: HTMLElement): () => void {
  const measure = () => {
    const covers = dock.offsetHeight > 0 && ["sticky", "fixed"].includes(getComputedStyle(dock).position);
    docks.set(dock, covers ? dock.offsetHeight : 0);
    publish();
  };
  const observer = new ResizeObserver(measure);
  observer.observe(dock);
  // A dock that is no longer stuck (a window made wider or lower) can keep its size: the window says so.
  window.addEventListener("resize", measure);
  measure();
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", measure);
    docks.delete(dock);
    publish();
  };
}

/** The dock's element, for the place that renders it to attach (as a ref) and to portal into, observed while it is there. */
export function useDock(): [HTMLElement | null, (element: HTMLElement | null) => void] {
  const [dock, setDock] = useState<HTMLElement | null>(null);
  useEffect(() => (dock ? observeDock(dock) : undefined), [dock]);
  return [dock, setDock];
}
