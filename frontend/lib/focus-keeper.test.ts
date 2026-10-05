import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, installDom } from "./test-dom";
import { keepFocusThroughBusy } from "./focus-keeper";

installDom();
afterEach(cleanup);

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A button with the focus that its action disables; the browser then moves the focus to the body (focus fixup). */
async function pressedAndBusy() {
  const button = document.createElement("button");
  button.textContent = "Försök igen";
  const other = document.createElement("button");
  other.textContent = "Alla flöden";
  document.body.append(button, other);
  const stop = keepFocusThroughBusy(document);
  button.focus();
  // jsdom moves no focus from a control it disables; the browser does, to the body, as this does.
  button.blur();
  button.disabled = true;
  await settle();
  return { button, other, stop };
}

test("a pressed button that was busy gets the focus back when it is enabled again", async () => {
  const { button, stop } = await pressedAndBusy();
  assert.equal(document.activeElement, document.body, "the busy button has lost it");
  button.disabled = false;
  await settle();
  assert.ok(document.activeElement === button, "back on the button");
  stop();
});

test("the focus is not taken back from where the person moved it meanwhile, nor given to a button that never had it", async () => {
  const { button, other, stop } = await pressedAndBusy();
  other.focus();
  button.disabled = false;
  await settle();
  assert.ok(document.activeElement === other);
  other.blur();
  other.disabled = true;
  const third = document.createElement("button");
  third.disabled = true;
  document.body.append(third);
  await settle();
  third.disabled = false;
  await settle();
  assert.ok(document.activeElement !== third, "never focused, never given the focus");
  stop();
});
