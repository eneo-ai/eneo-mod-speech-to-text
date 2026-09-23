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
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

/** Types into a React-controlled field the way a browser does: the value, then an input event. */
export function type(field: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const prototype = field instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, text);
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
}
