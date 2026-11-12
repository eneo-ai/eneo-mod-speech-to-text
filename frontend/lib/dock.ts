import { useEffect, useState, type FocusEvent as ReactFocusEvent } from "react";

/**
 * What is docked at the bottom of a phone's window (the setup's primary action, a player) covers the page's last rows,
 * so a control that takes focus must scroll to above it (WCAG 2.4.11). Its height is not a number to write down: its
 * words, a longer note and the text spacing a reader may set all change it. Each dock reports its own. A dedicated
 * CSS rule keeps the page's scroll padding at the edges where a dock is shown. Updating that rule changes the root's
 * non-inherited properties without mutating its attributes, which can restyle every passage of a long transcript.
 */
type DockEdge = "bottom" | "top";
const docks = new Map<HTMLElement, { size: number; edge: DockEdge | null; yields: boolean }>();
/** The measures of the docks that yield, run again when a dock that does not yield changes what it covers. */
const yielding = new Set<() => void>();
/** Every dock's measure, run again when a region puts its docks in the page's flow for a soft keyboard (whileTyping). */
const measures = new Set<() => void>();
let padding: { sheet: CSSStyleSheet; style: CSSStyleDeclaration } | undefined;

let typingMeasure = 0;

function typing(region: HTMLElement, on: boolean) {
  if (region.hasAttribute("data-typing") === on) return;
  region.toggleAttribute("data-typing", on);
  // In the next frame, once the page has laid out what the focus opened or closed (a passage's editor), not inside it:
  // a long transcript read in the middle of that would be laid out twice.
  typingMeasure ||= requestAnimationFrame(() => {
    typingMeasure = 0;
    measures.forEach((again) => again());
  });
}

/**
 * For the region whose docks stand in the page's flow while one of its text fields has the focus (a touch screen's soft
 * keyboard opens over the window's lower half, and a dock there would cover the text being typed): spread on that
 * region's element, it says so in `data-typing`, which the region's CSS reads (a coarse pointer only), and the docks are
 * measured again in the next frame, so what they cover is what the page is told (iOS resizes no window for its
 * keyboard). An attribute set by hand, not a render or a `:has()`: neither should touch two thousand passages for a
 * focus.
 */
export const whileTyping = {
  onFocus: (event: ReactFocusEvent<HTMLElement>) => {
    listen();
    settle(event.currentTarget, (event.target as Element).matches("input, textarea"));
  },
  onBlur: (event: ReactFocusEvent<HTMLElement>) => settle(event.currentTarget, false),
};

/**
 * How the focus is moved. One a press gives (a finger, the pointer) is where the press is: no dock uncovers it
 * (`pressed`, until a key is pressed), and a region's typing ends only once the press is let go (`held`, from its mouse
 * button's down to its up; a finger's press sends them once lifted, and the browser looks again for what the up lands on
 * when the page changed under it): a dock stuck again between the two would stand over what was pressed, and the press
 * would land on the dock. A focus the keyboard moves ends the typing at once. Both are the page's, not a dock's: a dock
 * observed again during a press (a player moved between a tablet's top and its text) is pressed as the page is.
 */
let pressed = false;
let held = false;
const letGo = new Set<HTMLElement>();
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  const release = () => {
    held = false;
    const focused = document.activeElement;
    letGo.forEach((region) => typing(region, !!focused && region.contains(focused) && focused.matches("input, textarea")));
    letGo.clear();
  };
  document.addEventListener("pointerdown", () => (pressed = true), true);
  document.addEventListener("mousedown", () => (held = true), true);
  document.addEventListener("mouseup", release, true);
  // A press can end with no mouse up: the browser took it over (pointercancel), it became a drag (dragend), it opened a
  // context menu, or the window lost the focus during it. Each lets it go too, or a field's later blur would keep the
  // dock in the text. Not pointerup: a finger's press moves the focus after it.
  for (const end of ["pointercancel", "dragend", "contextmenu"]) document.addEventListener(end, release, true);
  window.addEventListener("blur", (event) => event.target === window && release());
  document.addEventListener("keydown", () => {
    pressed = false;
    release();
  }, true);
}

function settle(region: HTMLElement, on: boolean) {
  if (!on && held) letGo.add(region);
  else typing(region, on);
}

function publish() {
  if (!docks.size) {
    if (padding) {
      const { sheet } = padding;
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((other) => other !== sheet);
    }
    padding = undefined;
    return;
  }
  if (!padding) {
    const sheet = new CSSStyleSheet();
    sheet.insertRule("html {}");
    padding = { sheet, style: (sheet.cssRules[0] as CSSStyleRule).style };
    document.adoptedStyleSheets.push(sheet);
  }
  const shown = [...docks.values()];
  const tallest = Math.max(0, ...shown.map(({ size }) => size));
  for (const edge of ["bottom", "top"] as const) {
    // The margin keeps the whole focus ring clear, including a padded field's outer edge.
    const value = shown.some((dock) => dock.edge === edge) ? `calc(${tallest}px + var(--spacing-6))` : "";
    const property = `scroll-padding-${edge}`;
    if (padding.style.getPropertyValue(property) === value) continue;
    if (value) padding.style.setProperty(property, value);
    else padding.style.removeProperty(property);
  }
}

/**
 * The most of the window's height a dock may cover. Large text (the reader's own size, iOS's text size) can make a dock
 * half the screen; past this share it stands in the page's flow at its end (`data-dock-too-tall`, styles/globals.css).
 */
const MOST_OF_WINDOW = 1 / 3;

/**
 * Keeps room for a dock while it is shown and covers the page (stuck to the window's edge). One in the page's flow
 * (a laptop's card) still ends what is read, so its edge keeps the focus margin alone.
 * A dock that `yields` (the transcript's player) counts the docks that do not (a page's action) into its share of the
 * window: past it, the player stands in the text and the action stays in reach.
 */
export function observeDock(dock: HTMLElement, edge: DockEdge = "bottom", yields = false): () => void {
  // The dock's height as last laid out (its observer and the window say when it changes): a measure on a focus reads no
  // layout, which on a long transcript would be laid out again for every focus that opens a passage's editor.
  let height = 0;
  const measure = (read = true) => {
    const inactive = dock.closest("[inert], [hidden]") !== null;
    if (read && !inactive) height = dock.offsetHeight;
    const visibleHeight = inactive ? 0 : height;
    const others = yields ? [...docks].reduce((sum, [other, { size, yields: alsoYields }]) => sum + (other === dock || alsoYields ? 0 : size), 0) : 0;
    const tooTall = visibleHeight > 0 && visibleHeight + others > window.innerHeight * MOST_OF_WINDOW;
    const wasTooTall = dock.hasAttribute("data-dock-too-tall");
    if (wasTooTall !== tooTall) dock.toggleAttribute("data-dock-too-tall", tooTall);
    const covers = !tooTall && visibleHeight > 0 && ["sticky", "fixed"].includes(getComputedStyle(dock).position);
    const size = covers ? visibleHeight : 0;
    const shown = visibleHeight > 0 ? edge : null;
    const before = docks.get(dock);
    if (before && before.size === size && before.edge === shown && wasTooTall === tooTall) return;
    docks.set(dock, { size, edge: shown, yields });
    publish();
    if (!yields && before?.size !== size) yielding.forEach((again) => again());
  };
  const remeasure = () => measure(false);
  measures.add(remeasure);
  if (yields) yielding.add(remeasure);
  // Safari scrolls a focused control into view only when it is outside the window, not when it is inside it under the
  // dock: the scroll padding does not count there. Such a control is scrolled clear here, as far as the padding says. One
  // in a dialog or a popover (a sheet over the dock) does not move with the page. One taller than the room the padding
  // leaves (a long text being edited) cannot be shown whole: it stays where it is read, as its own focus handling keeps it.
  // What holds the dock (a player's region) moves with it: no scroll uncovers it. A focus a press gives is where the
  // finger or the pointer is: a scroll between the press's down and up would land the press beside what was pressed (a
  // word of the review's text, whose passage takes the focus), so only the keyboard's focus is uncovered.
  listen();
  // A dock a region put in its flow for a soft keyboard (whileTyping) is measured once that has been laid out. One
  // measured covering nothing (the window resized for the keyboard) is looked at again before a control is uncovered
  // while it says it covers none.
  const uncover = ({ target }: FocusEvent) => {
    if (!docks.get(dock)?.size) remeasure();
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
  const observer = new ResizeObserver(() => measure());
  observer.observe(dock);
  // A panel that skips rendering can keep its children's last laid-out sizes. Its visibility changes independently
  // of a resize; observe only ancestor attributes, never the transcript's subtree or its per-word changes.
  const visibility = new MutationObserver(() => measure());
  for (let ancestor: HTMLElement | null = dock; ancestor; ancestor = ancestor.parentElement) {
    visibility.observe(ancestor, { attributes: true, attributeFilter: ["inert", "hidden"] });
  }
  // A dock that is no longer stuck (a window made wider or lower) can keep its size: the window says so.
  const resized = () => measure();
  window.addEventListener("resize", resized);
  document.addEventListener("focusin", uncover);
  measure();
  return () => {
    observer.disconnect();
    visibility.disconnect();
    window.removeEventListener("resize", resized);
    document.removeEventListener("focusin", uncover);
    yielding.delete(remeasure);
    measures.delete(remeasure);
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
