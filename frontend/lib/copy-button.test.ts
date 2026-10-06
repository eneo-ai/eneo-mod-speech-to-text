import assert from "node:assert/strict";
import test, { afterEach, type TestContext } from "node:test";
import { createElement } from "react";

import { cleanup, installDom, mount } from "./test-dom";

installDom();
afterEach(cleanup);

/** A clipboard that takes the text, or refuses it (a page without permission, or an insecure origin). */
function useClipboard(t: TestContext, clipboard: { writeText: (text: string) => Promise<void> } | undefined) {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
  t.after(() => {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
  });
}

async function copyButton(props: { text?: string; name?: string } = {}) {
  const { CopyButton } = await import("../components/flow/CopyButton");
  const view = await mount(createElement(CopyButton, { text: props.text ?? "Texten", label: "Kopiera", name: props.name }));
  const button = () => view.container.querySelector("button")!;
  const status = () => document.querySelector('[data-astryx-live-region="polite"]')?.textContent ?? "";
  return { ...view, button, status };
}

test("the button is named by more than its words where it says so, and says Kopierat once after a copy", async (t) => {
  const written: string[] = [];
  useClipboard(t, { writeText: async (text) => void written.push(text) });
  const { button, status, act } = await copyButton({ name: "Kopiera transkriberingen" });
  assert.equal(button().textContent, "Kopiera");
  assert.equal(button().getAttribute("aria-label"), "Kopiera transkriberingen", "its name starts with the words it shows");

  await act(async () => button().click());
  await new Promise(requestAnimationFrame);
  assert.deepEqual(written, ["Texten"]);
  assert.equal(button().textContent, "Kopierat");
  assert.equal(button().getAttribute("aria-label"), null, "the words are the name while it confirms");
  assert.equal(status(), "Kopierat");
});

test("a clipboard that refuses, or is not there, says so in words and returns to Kopiera after a moment", async (t) => {
  useClipboard(t, undefined);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { button, status, act } = await copyButton();
  await act(async () => button().click());
  await new Promise(requestAnimationFrame);
  assert.equal(button().textContent, "Kunde inte kopiera");
  assert.equal(status(), "Det gick inte att kopiera. Markera texten och kopiera den själv.");

  await act(async () => t.mock.timers.tick(2_500));
  assert.equal(button().textContent, "Kopiera");
  assert.equal(status(), "");
});

test("two quick copies announce each completed outcome in one persistent region", async (t) => {
  useClipboard(t, { writeText: async () => undefined });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { button, status, act, container } = await copyButton();
  await act(async () => button().click());
  await new Promise(requestAnimationFrame);
  const region = document.querySelector('[data-astryx-live-region="polite"]');
  assert.ok(region, "an announcement region remains outside the changing button");
  assert.equal(status(), "Kopierat");
  await act(async () => button().click());
  assert.equal(status(), "", "the previous outcome is cleared even when the copy state is already copied");
  await new Promise(requestAnimationFrame);
  assert.equal(document.querySelector('[data-astryx-live-region="polite"]'), region);
  assert.equal(container.querySelectorAll('[role="status"]').length, 1, "only the design system button's empty busy region remains");
  assert.equal(status(), "Kopierat");

  await act(async () => t.mock.timers.tick(2_500));
  assert.equal(button().textContent, "Kopiera");
  assert.equal(status(), "");
});
