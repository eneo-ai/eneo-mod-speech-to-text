import { useEffect, useState } from "react";

/**
 * What is docked at the bottom of a phone's window (the setup's primary action, a player) covers the page's last rows,
 * so a control that takes focus must scroll to above it (WCAG 2.4.11). Its height is not a number to write down: its
 * words, a longer note and the text spacing a reader may set all change it. Each dock reports its own, and the page
 * keeps the tallest in `--dock-block-size` on <html>, which styles/globals.css reads as the scroll padding.
 */
const docks = new Map<HTMLElement, number>();

function publish() {
  const tallest = Math.max(0, ...docks.values());
  const root = document.documentElement.style;
  if (tallest > 0) root.setProperty("--dock-block-size", `${tallest}px`);
  else root.removeProperty("--dock-block-size");
}

/**
 * The most of the window's height a dock may cover. Large text (the reader's own size, iOS's text size) can make a dock
 * half the screen; past this share it stands in the page's flow at its end (`data-dock-too-tall`, styles/globals.css).
 */
const MOST_OF_WINDOW = 1 / 3;

/** Keeps a dock's height in `--dock-block-size` while it is on the page and covers it (stuck to the window's edge). */
export function observeDock(dock: HTMLElement): () => void {
  const measure = () => {
    const tooTall = dock.offsetHeight > window.innerHeight * MOST_OF_WINDOW;
    dock.toggleAttribute("data-dock-too-tall", tooTall);
    const covers = !tooTall && dock.offsetHeight > 0 && ["sticky", "fixed"].includes(getComputedStyle(dock).position);
    docks.set(dock, covers ? dock.offsetHeight : 0);
    publish();
  };
  // Safari scrolls a focused control into view only when it is outside the window, not when it is inside it under the
  // dock: the scroll padding does not count there. Such a control is scrolled clear here, as far as the padding says. One
  // in a dialog or a popover (a sheet over the dock) does not move with the page. One taller than the room the padding
  // leaves (a long text being edited) cannot be shown whole: it stays where it is read, as its own focus handling keeps it.
  // What holds the dock (a player's region) moves with it: no scroll uncovers it. A focus a press gives is where the
  // finger or the pointer is: a scroll between the press's down and up would land the press beside what was pressed (a
  // word of the review's text, whose passage takes the focus), so only the keyboard's focus is uncovered.
  let pressed = false;
  const press = () => {
    pressed = true;
  };
  const key = () => {
    pressed = false;
  };
  const uncover = ({ target }: FocusEvent) => {
    if (pressed || !docks.get(dock) || !(target instanceof Element) || dock.contains(target) || target.contains(dock)) return;
    if (target.closest("dialog, [popover]")) return;
    const box = target.getBoundingClientRect();
    const edge = dock.getBoundingClientRect();
    if (box.bottom <= edge.top || box.top >= edge.bottom) return;
    const padding = getComputedStyle(document.documentElement);
    const above = Number.parseFloat(padding.scrollPaddingTop) || 0;
    const below = Number.parseFloat(padding.scrollPaddingBottom) || 0;
    if (box.height > window.innerHeight - above - below) return;
    const atTop = edge.top + edge.bottom < window.innerHeight;
    const top = atTop ? box.top - above : box.bottom - window.innerHeight + below;
    window.scrollBy({ top, behavior: "instant" });
  };
  const observer = new ResizeObserver(measure);
  observer.observe(dock);
  // A dock that is no longer stuck (a window made wider or lower) can keep its size: the window says so.
  window.addEventListener("resize", measure);
  document.addEventListener("pointerdown", press, true);
  document.addEventListener("keydown", key, true);
  document.addEventListener("focusin", uncover);
  measure();
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", measure);
    document.removeEventListener("pointerdown", press, true);
    document.removeEventListener("keydown", key, true);
    document.removeEventListener("focusin", uncover);
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
