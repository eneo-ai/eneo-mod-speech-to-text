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

test("the page says at which edge a dock is shown, so its scroll padding is kept on that edge alone", async () => {
  const { observeDock } = await import("./dock");
  const edges = () => document.documentElement.getAttribute("data-dock");
  assert.equal(edges(), null);
  const action = dock(141);
  const stopAction = observeDock(action);
  assert.equal(edges(), "bottom", "the setup's action, a phone's player");
  const player = dock(96);
  const stopPlayer = observeDock(player, "top");
  assert.equal(edges(), "bottom top", "a tablet's player above the text, with an action at the bottom");
  stopAction();
  assert.equal(edges(), "top");
  // A player at the end of a laptop's card is in the page's flow: it covers nothing, but focus still stops short of it.
  const inFlow = dock(96, "static");
  const stopInFlow = observeDock(inFlow);
  assert.equal(edges(), "bottom top");
  stopPlayer();
  stopInFlow();
  // An empty slot (a laptop's setup docks nothing into it) and a player in a hidden tab are no dock.
  const empty = dock(0);
  const stopEmpty = observeDock(empty);
  assert.equal(edges(), null, "nothing shown, no edge");
  stopEmpty();
  [action, player, inFlow, empty].forEach((element) => element.remove());
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
  // A control in the dock is under it by its nature: it stays put (the speed menu opens from where it is).
  t.mock.method(button, "getBoundingClientRect", () => box(window.innerHeight - 80, 44));
  button.focus();
  assert.deepEqual(scrolled, [118], "the dock's own controls stay put");

  // A text being edited that is taller than the room above the dock opens where it is read (ReviewView).
  const editor = document.createElement("textarea");
  document.body.append(editor);
  t.mock.method(editor, "getBoundingClientRect", () => box(200, 1200));
  editor.focus({ preventScroll: true });
  assert.deepEqual(scrolled, [118], "a field the window cannot hold whole is not moved");
  editor.remove();

  // The region that holds the dock (a player focused by a press on its text) cannot be uncovered by moving the page: the
  // dock moves with it, and a press that scrolled between its down and up would land beside what was pressed.
  const region = document.createElement("section");
  region.tabIndex = 0;
  document.body.append(region);
  region.append(bar);
  t.mock.method(region, "getBoundingClientRect", () => box(300, 400));
  region.focus();
  assert.deepEqual(scrolled, [118], "what holds the dock is left where it is");
  document.body.append(bar);
  region.remove();

  // A control a press focuses is where the press was: a scroll between the press's down and up would land the press
  // beside it (a word of the review's text, whose passage takes the focus). The keyboard's next focus is uncovered.
  field.blur();
  t.mock.method(field, "getBoundingClientRect", () => box(window.innerHeight - 30, 24));
  document.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  field.focus();
  assert.deepEqual(scrolled, [118], "a control a press focuses stays under the finger");
  field.blur();
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  field.focus();
  assert.deepEqual(scrolled, [118, 118], "the keyboard's focus is scrolled clear of the dock again");

  stop();
  field.remove();
  bar.remove();
  document.documentElement.style.removeProperty("scroll-padding-bottom");
});

test("a dock that yields stands in the page when it and the docks that do not yield would cover more than a third", async () => {
  const { observeDock } = await import("./dock");
  const third = Math.ceil(window.innerHeight / 3);
  // The speaker review's decision at the bottom, its transcript's player on top (TranscriptPlayer).
  const decision = dock(third - 60);
  const stopDecision = observeDock(decision);
  const player = dock(50);
  const stopPlayer = observeDock(player, "top", true);
  assert.ok(!player.hasAttribute("data-dock-too-tall"), "together within a third: both docked");
  Object.defineProperty(decision, "offsetHeight", { configurable: true, get: () => third - 20 });
  window.dispatchEvent(new window.Event("resize"));
  assert.ok(player.hasAttribute("data-dock-too-tall"), "larger text: the player stands in the text");
  assert.ok(!decision.hasAttribute("data-dock-too-tall"), "the decision stays in reach");
  stopDecision();
  assert.ok(!player.hasAttribute("data-dock-too-tall"), "the decision gone: the player is docked again");
  stopPlayer();
  [decision, player].forEach((element) => element.remove());
});

test("a dock that is stuck again when a field loses the focus is measured again, with no resize", async (t) => {
  const { observeDock } = await import("./dock");
  const bar = dock(100);
  const stop = observeDock(bar);
  const field = document.createElement("textarea");
  document.body.append(field);
  // While a field has the focus a touch screen's soft keyboard is up, and the page puts the dock in its flow
  // (ReviewView's data-typing): it covers nothing then.
  // As React's onFocus and onBlur, which listen for focusin and focusout above the page.
  field.addEventListener("focusin", () => (bar.style.position = "static"));
  field.addEventListener("focusout", () => (bar.style.position = "sticky"));
  field.focus();
  assert.equal(size(), "", "typing: in the page's flow");
  field.blur();
  assert.equal(size(), "100px", "done typing: docked and measured again, so focus stops short of it");
  stop();
  [bar, field].forEach((element) => element.remove());
  t.mock.restoreAll();
});
