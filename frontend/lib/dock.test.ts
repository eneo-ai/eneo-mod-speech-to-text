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
