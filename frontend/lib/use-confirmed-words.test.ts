import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { cleanup, installDom, mount } from "./test-dom";

installDom();
afterEach(cleanup);

test("confirming a word where the browser refuses site data keeps it for the page, and nothing throws", async (t) => {
  const { createElement } = await import("react");
  const { useConfirmedWords } = await import("../components/useConfirmedWords");
  const own = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("denied", "SecurityError");
    },
  });
  t.after(() => {
    if (own) Object.defineProperty(window, "localStorage", own);
  });
  let confirmed: ReadonlySet<string> = new Set();
  let toggle: (key: string) => void = () => undefined;
  function Probe() {
    [confirmed, toggle] = useConfirmedWords("tal-till-text:confirmed-words:user-1:flow/run/step");
    return null;
  }
  const view = await mount(createElement(Probe));
  await view.act(async () => toggle("0:0:Hej"));
  assert.deepEqual([...confirmed], ["0:0:Hej"]);
});
