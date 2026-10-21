import assert from "node:assert/strict";
import test from "node:test";
import { installDom } from "./test-dom";

installDom();

const size = () => document.documentElement.style.getPropertyValue("--dock-block-size");

/** A dock of the given height; jsdom has no layout, so its height is said. */
function dock(height: number, position = "sticky") {
  const element = document.createElement("div");
  element.style.position = position;
  Object.defineProperty(element, "offsetHeight", { configurable: true, get: () => height });
  document.body.append(element);
  return element;
}

test("the page keeps the height of the tallest dock that covers it, and nothing once none does", async () => {
  const { observeDock } = await import("./dock");
  assert.equal(size(), "");
  const action = dock(141);
  const stopAction = observeDock(action);
  assert.equal(size(), "141px", "the dock's own height, not a number written down");
  const player = dock(96);
  const stopPlayer = observeDock(player);
  assert.equal(size(), "141px", "the tallest of two docks");
  stopAction();
  assert.equal(size(), "96px", "the one that is left");
  stopPlayer();
  assert.equal(size(), "", "none left: no padding is promised");
  action.remove();
  player.remove();
});

test("a dock that is not stuck to the window's edge, or is not shown, covers nothing", async () => {
  const { observeDock } = await import("./dock");
  const inFlow = dock(141, "static");
  const hidden = dock(0);
  const stops = [observeDock(inFlow), observeDock(hidden)];
  assert.equal(size(), "", "a bar in the page's flow (a laptop, a short screen) hides nothing");
  stops.forEach((stop) => stop());
  inFlow.remove();
  hidden.remove();
});

test("a dock that stops being stuck when the window changes is measured again", async () => {
  const { observeDock } = await import("./dock");
  const bar = dock(120);
  const stop = observeDock(bar);
  assert.equal(size(), "120px");
  bar.style.position = "static";
  window.dispatchEvent(new window.Event("resize"));
  assert.equal(size(), "", "wider or lower, the bar is back in the page");
  stop();
  bar.remove();
});

test("a dock taller than a third of the window stands in the page instead of covering it", async () => {
  const { observeDock } = await import("./dock");
  const bar = dock(Math.ceil(window.innerHeight / 3) + 1);
  const stop = observeDock(bar);
  assert.equal(size(), "", "large text made the bar too tall to keep over the page");
  assert.ok(bar.hasAttribute("data-dock-too-tall"));
  Object.defineProperty(bar, "offsetHeight", { configurable: true, get: () => 120 });
  window.dispatchEvent(new window.Event("resize"));
  assert.equal(size(), "120px", "smaller text: docked again");
  assert.ok(!bar.hasAttribute("data-dock-too-tall"));
  stop();
  bar.remove();
});

test("a control the keyboard focuses under a dock, inside the window, is scrolled clear of it, as Safari does not", async (t) => {
  const { observeDock } = await import("./dock");
  const bar = dock(100);
  const stop = observeDock(bar);
  // The page's scroll padding: the dock's height and a margin (styles/globals.css).
  document.documentElement.style.scrollPaddingBottom = "124px";
  const box = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  t.mock.method(bar, "getBoundingClientRect", () => box(window.innerHeight - 100, 100));
  const scrolled: (number | undefined)[] = [];
  t.mock.method(window, "scrollBy", (options: ScrollToOptions) => void scrolled.push(options.top));
  const field = document.createElement("input");
  const button = document.createElement("button");
  bar.append(button);
  document.body.append(field);

  t.mock.method(field, "getBoundingClientRect", () => box(window.innerHeight - 200, 24));
  field.focus();
  assert.deepEqual(scrolled, [], "clear of the dock: left where it is");
  field.blur();

  t.mock.method(field, "getBoundingClientRect", () => box(window.innerHeight - 30, 24));
  field.focus();
  assert.deepEqual(scrolled, [118], "under the dock: up until its bottom edge meets the scroll padding");
  button.focus();
  assert.deepEqual(scrolled, [118], "the dock's own controls stay put");

  // A text being edited that is taller than the room above the dock opens where it is read (ReviewView).
  const editor = document.createElement("textarea");
  document.body.append(editor);
  t.mock.method(editor, "getBoundingClientRect", () => box(200, 1200));
  editor.focus({ preventScroll: true });
  assert.deepEqual(scrolled, [118], "a field the window cannot hold whole is not moved");
  editor.remove();

  stop();
  field.remove();
  bar.remove();
  document.documentElement.style.removeProperty("scroll-padding-bottom");
});
