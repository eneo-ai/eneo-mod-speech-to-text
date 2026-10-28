import { useEffect, useState } from "react";

/**
 * What is docked at the bottom of a phone's window (the setup's primary action, a player) covers the page's last rows,
 * so a control that takes focus must scroll to above it (WCAG 2.4.11). Its height is not a number to write down: its
 * words, a longer note and the text spacing a reader may set all change it. Each dock reports its own, and the page
 * keeps the tallest in `--dock-block-size` on <html>, which styles/globals.css reads as the scroll padding, and the
 * edges a dock is shown at in `data-dock` ("bottom", "top" or both), which says which edge that padding is for. An
 * attribute, never a `:has()` over the page: one makes the browser check every element of a long transcript again
 * whenever its passages change.
 */
type DockEdge = "bottom" | "top";
const docks = new Map<HTMLElement, { size: number; edge: DockEdge | null; yields: boolean }>();
/** The measures of the docks that yield, run again when a dock that does not yield changes what it covers. */
const yielding = new Set<() => void>();

function publish() {
  const shown = [...docks.values()];
  const tallest = Math.max(0, ...shown.map(({ size }) => size));
  const root = document.documentElement;
  if (tallest > 0) root.style.setProperty("--dock-block-size", `${tallest}px`);
  else root.style.removeProperty("--dock-block-size");
  const edges = (["bottom", "top"] as const).filter((edge) => shown.some((dock) => dock.edge === edge));
  if (edges.length) root.setAttribute("data-dock", edges.join(" "));
  else root.removeAttribute("data-dock");
}

/**
 * The most of the window's height a dock may cover. Large text (the reader's own size, iOS's text size) can make a dock
 * half the screen; past this share it stands in the page's flow at its end (`data-dock-too-tall`, styles/globals.css).
 */
const MOST_OF_WINDOW = 1 / 3;

/**
 * Keeps a dock's height in `--dock-block-size` while it is on the page and covers it (stuck to the window's edge), and
 * its edge in `data-dock` while it is shown at all: one in the page's flow (a laptop's card) still ends what is read.
 * A dock that `yields` (the transcript's player) counts the docks that do not (a page's action) into its share of the
 * window: past it, the player stands in the text and the action stays in reach.
 */
export function observeDock(dock: HTMLElement, edge: DockEdge = "bottom", yields = false): () => void {
  const measure = () => {
    const others = yields ? [...docks].reduce((sum, [other, { size, yields: alsoYields }]) => sum + (other === dock || alsoYields ? 0 : size), 0) : 0;
    const tooTall = dock.offsetHeight + others > window.innerHeight * MOST_OF_WINDOW;
    dock.toggleAttribute("data-dock-too-tall", tooTall);
    const covers = !tooTall && dock.offsetHeight > 0 && ["sticky", "fixed"].includes(getComputedStyle(dock).position);
    const size = covers ? dock.offsetHeight : 0;
    const changed = docks.get(dock)?.size !== size;
    docks.set(dock, { size, edge: dock.offsetHeight > 0 ? edge : null, yields });
    publish();
    if (!yields && changed) yielding.forEach((again) => again());
  };
  if (yields) yielding.add(measure);
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
  // A page that puts its dock in its flow while a field has the focus (a touch screen's soft keyboard: ReviewView's and
  // TranscriptPlayer's data-typing) changes no size: the dock is measured again as the focus comes and goes, after the
  // page's own focus handlers, before a control is uncovered.
  const uncover = ({ target }: FocusEvent) => {
    measure();
    if (pressed || !docks.get(dock)?.size || !(target instanceof Element) || dock.contains(target) || target.contains(dock)) return;
    if (target.closest("dialog, [popover]")) return;
    const box = target.getBoundingClientRect();
    const area = dock.getBoundingClientRect();
    if (box.bottom <= area.top || box.top >= area.bottom) return;
    const padding = getComputedStyle(document.documentElement);
    const above = Number.parseFloat(padding.scrollPaddingTop) || 0;
    const below = Number.parseFloat(padding.scrollPaddingBottom) || 0;
    if (box.height > window.innerHeight - above - below) return;
    const atTop = area.top + area.bottom < window.innerHeight;
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
  document.addEventListener("focusout", measure);
  measure();
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", measure);
    document.removeEventListener("pointerdown", press, true);
    document.removeEventListener("keydown", key, true);
    document.removeEventListener("focusin", uncover);
    document.removeEventListener("focusout", measure);
    yielding.delete(measure);
    docks.delete(dock);
    publish();
    if (!yields) yielding.forEach((again) => again());
  };
}

/**
 * The dock's element, for the place that renders it to attach (as a ref) and to portal into, observed while it is there
 * at the window's `edge`.
 */
export function useDock(edge: DockEdge = "bottom", yields = false): [HTMLElement | null, (element: HTMLElement | null) => void] {
  const [dock, setDock] = useState<HTMLElement | null>(null);
  useEffect(() => (dock ? observeDock(dock, edge, yields) : undefined), [dock, edge, yields]);
  return [dock, setDock];
}
