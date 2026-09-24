import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { button, cleanup, installDom, mount } from "./test-dom";

installDom();
afterEach(cleanup);

test("signed out: the page stays mounted with all it holds, hidden and out of reach, until the new login", async () => {
  const { createElement, useState } = await import("react");
  const { SignedOutCover } = await import("../components/AuthGate");
  function Counter() {
    const [count, setCount] = useState(0);
    return createElement("button", { type: "button", onClick: () => setCount(count + 1) }, `Räknat ${count}`);
  }
  let setSignedOut: (on: boolean) => void = () => {};
  function Page() {
    const [signedOut, set] = useState(false);
    setSignedOut = set;
    return createElement(SignedOutCover, { signedOut, children: createElement(Counter) });
  }
  const { container, act } = await mount(createElement(Page));
  await act(async () => button(container, "Räknat 0")!.click());
  const cover = () => container.firstElementChild as HTMLElement;
  assert.equal(cover().hasAttribute("inert"), false);

  await act(async () => setSignedOut(true));
  assert.equal(cover().hasAttribute("inert"), true, "out of reach");
  assert.match(cover().className, /\binvisible\b/, "and not shown");
  assert.ok(button(container, "Räknat 1"), "still there, as it was");

  await act(async () => setSignedOut(false));
  assert.equal(cover().hasAttribute("inert"), false);
  assert.doesNotMatch(cover().className, /\binvisible\b/);
  assert.ok(button(container, "Räknat 1"));
});

test("signed out: the dialog asks for a new login, says the page and a recording go on, and cannot be closed without one", async () => {
  const { createElement } = await import("react");
  const { SessionEndWarning } = await import("../components/SessionEndWarning");
  const { act } = await mount(
    createElement(SessionEndWarning, { endsAt: Date.now() + 3_600_000, mode: "eneo_sso", signedOut: true, onRenewed: () => {} }),
  );
  const dialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]');
  assert.match(dialog()?.textContent ?? "", /Du behöver logga in igen/);
  assert.match(dialog()?.textContent ?? "", /inspelning fortsätter/);
  assert.ok(button(dialog()!, "Logga in igen"));
  assert.equal(button(dialog()!, "Stäng"), null, "no way past it but the new login");

  await act(async () => {
    dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.ok(dialog(), "Escape keeps it open");
});
