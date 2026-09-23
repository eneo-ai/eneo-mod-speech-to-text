/**
 * A browser document for component tests that need focus and events, which
 * static markup cannot show. Call before importing React DOM or a component,
 * then render with `mount` inside the test.
 */

import { JSDOM } from "jsdom";

const GLOBALS = [
  "window",
  "self",
  "document",
  "navigator",
  "localStorage",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLButtonElement",
  "HTMLSelectElement",
  "DocumentFragment",
  "Event",
  "CustomEvent",
  "FocusEvent",
  "KeyboardEvent",
  "MouseEvent",
  "InputEvent",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;

export function installDom(): JSDOM {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Record<string, unknown>;
  // Every DOM interface Node lacks (HTMLFormElement and the rest), then the ones Node has its own of.
  const missing = Object.getOwnPropertyNames(dom.window).filter((key) => /^[A-Z]/.test(key) && !(key in globalThis));
  for (const key of [...missing, ...GLOBALS]) {
    const value = win[key];
    Object.defineProperty(globalThis, key, {
      value: typeof value === "function" && /^[a-z]/.test(key) ? (value as (...args: unknown[]) => unknown).bind(dom.window) : value,
      configurable: true,
      writable: true,
    });
  }
  // Layout calls jsdom does not have; a list that opens scrolls its choice into view.
  dom.window.Element.prototype.scrollIntoView = () => {};
  dom.window.Element.prototype.hasPointerCapture = () => false;
  dom.window.Element.prototype.releasePointerCapture = () => {};
  // Media queries match nothing (no reduced motion, no touch screen); popovers measure with a ResizeObserver.
  const matchMedia = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
  Object.defineProperty(dom.window, "matchMedia", { value: matchMedia, configurable: true, writable: true });
  Object.defineProperty(globalThis, "matchMedia", { value: matchMedia, configurable: true, writable: true });
  // Next's Link prefetches in an idle callback that it reaches through `self`.
  Object.defineProperty(globalThis, "self", { value: dom.window, configurable: true, writable: true });
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  Object.defineProperty(dom.window, "ResizeObserver", { value: ResizeObserver, configurable: true, writable: true });
  Object.defineProperty(globalThis, "ResizeObserver", { value: ResizeObserver, configurable: true, writable: true });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

/** Types into a React-controlled field the way a browser does: the value, then an input event. */
export function type(field: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const prototype = field instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, text);
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
}

const mounted = new Set<() => Promise<void>>();

/** Renders an element into a fresh container under `act`, with a way to take it down again. */
export async function mount(element: import("react").ReactElement) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  const unmount = async () => {
    if (!mounted.delete(unmount)) return;
    await act(async () => root.unmount());
    container.remove();
  };
  mounted.add(unmount);
  return { container, act, unmount };
}

/** Takes down whatever a test left mounted, also when an assertion stopped it early (use with afterEach). */
export async function cleanup(): Promise<void> {
  for (const unmount of [...mounted]) await unmount();
}

/** A button by its visible words or its accessible name, anywhere under `within`. */
export function button(within: ParentNode, name: string): HTMLButtonElement | null {
  return [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name) ?? null;
}
