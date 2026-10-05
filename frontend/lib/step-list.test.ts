import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";

import { cleanup, installDom, mount } from "./test-dom";
import type { StepView } from "./run-progress";

installDom();
afterEach(cleanup);

const step = (order: number, state: StepView["state"], note: string | null = null): StepView => ({
  order,
  label: `Steg ${order}`,
  state,
  transcribes: false,
  note,
});

async function list(steps: StepView[]) {
  const { ModuleProviders } = await import("@/kit/ModuleProviders");
  const { StepList } = await import("../components/flow/StepList");
  const view = await mount(createElement(ModuleProviders, null, createElement(StepList, { steps })));
  return { ...view, items: [...view.container.querySelectorAll("ol > li")] };
}

/** What a screen reader reads of an element: its text, without what is hidden from it. */
const spoken = (node: Node): string =>
  node.nodeType === Node.TEXT_NODE
    ? (node.textContent ?? "")
    : node instanceof Element && node.getAttribute("aria-hidden") !== "true"
      ? [...node.childNodes].map(spoken).join(" ")
      : "";
const said = (el: Element) => spoken(el).replace(/\s+/g, " ").trim();

test("the steps are one ordered list, and the first that is not done is the current one", async () => {
  const running = await list([step(1, "done"), step(2, "running"), step(3, "waiting")]);
  assert.equal(running.container.querySelector("ol")?.getAttribute("aria-label"), "Flödets steg");
  assert.deepEqual(running.items.map((li) => li.getAttribute("aria-current")), [null, "step", null]);
  await running.unmount();

  const failed = await list([step(1, "done"), step(2, "failed"), step(3, "not_run")]);
  assert.deepEqual(failed.items.map((li) => li.getAttribute("aria-current")), [null, "step", null], "where the run stopped");
  await failed.unmount();

  const queued = await list([step(1, "waiting"), step(2, "waiting")]);
  assert.deepEqual(queued.items.map((li) => li.getAttribute("aria-current")), ["step", null], "the step the run takes first");
  await queued.unmount();

  const done = await list([step(1, "done"), step(2, "done")]);
  assert.deepEqual(done.items.map((li) => li.getAttribute("aria-current")), [null, null], "nothing left to be current");
});

test("each step says its state in words, and a screen reader hears it once", async () => {
  const states: StepView["state"][] = ["done", "running", "waiting", "failed", "cancelled", "not_run"];
  const { items } = await list(states.map((state, i) => step(i + 1, state)));
  // A finished step is "slutfört" to the design system itself; the page's own "Klar" is for the eye.
  assert.deepEqual(
    items.map(said),
    ["Steg 1 slutfört", "Steg 2 Pågår", "Steg 3 Väntar", "Steg 4 Misslyckades", "Steg 5 Avbröts", "Steg 6 Kördes inte"],
  );
  assert.match(items[0].textContent ?? "", /Klar/, "and it is there to see");
});

test("a note a step will stop for the person with is its own line under it", async () => {
  const { items } = await list([step(1, "done"), step(2, "waiting", "Här bekräftar du vem som är vem.")]);
  assert.equal(said(items[1]), "Steg 2 Väntar Här bekräftar du vem som är vem.");
});
