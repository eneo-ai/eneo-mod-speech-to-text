import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";

import { button, cleanup, installDom, mount } from "./test-dom";
import { withRouter } from "./test-router";

installDom();
afterEach(cleanup);

const SLOW = "Det tar längre tid än vanligt.";

async function slowWait(props: { flows?: boolean } = {}) {
  const { SlowWait } = await import("../components/SlowWait");
  let retries = 0;
  const view = await mount(withRouter(createElement(SlowWait, { onRetry: () => (retries += 1), ...props })).tree);
  // The buttons keep live regions of their own, empty until they announce.
  const status = () => [...view.container.querySelectorAll('[role="status"]')].map((region) => region.textContent).filter(Boolean);
  return { ...view, status, retries: () => retries };
}

test("a wait that goes on says so after 15 seconds, with a way on; before that it says nothing", async (t) => {
  const { SLOW_WAIT_MS } = await import("../components/SlowWait");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { container, act, status } = await slowWait();
  assert.equal(container.textContent, "", "nothing before the wait is long");

  await act(async () => t.mock.timers.tick(SLOW_WAIT_MS - 1));
  assert.equal(container.textContent, "");

  await act(async () => t.mock.timers.tick(1));
  assert.deepEqual(status(), [SLOW], "said once, in a status region");
  assert.ok(button(container, "Försök igen"));
  assert.equal(container.querySelector('a[href="/flows"]')?.textContent, "Alla flöden");
});

test("a wait on the flow list offers no way back to the flow list", async (t) => {
  const { SLOW_WAIT_MS } = await import("../components/SlowWait");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { container, act } = await slowWait({ flows: false });
  await act(async () => t.mock.timers.tick(SLOW_WAIT_MS));
  assert.ok(button(container, "Försök igen"));
  assert.equal(container.querySelector('a[href="/flows"]'), null);
});

test("Försök igen tries again, keeps focus where it was, says so, and the wait is judged again from there", async (t) => {
  const { SLOW_WAIT_MS } = await import("../components/SlowWait");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { container, act, status, retries } = await slowWait();
  await act(async () => t.mock.timers.tick(SLOW_WAIT_MS));
  const retry = button(container, "Försök igen")!;
  retry.focus();

  await act(async () => retry.click());
  assert.equal(retries(), 1);
  assert.deepEqual(status(), ["Försöker igen."]);
  assert.equal(document.activeElement, button(container, "Försök igen"), "the press does not take the focus away");

  await act(async () => t.mock.timers.tick(SLOW_WAIT_MS));
  assert.deepEqual(status(), [SLOW], "still no answer: said again");
});

/** A page's router and signed-in person, as the app gives them. */
async function onPage(element: import("react").ReactElement) {
  const { asPerson } = await import("./test-dom");
  const { ColorModeProvider } = await import("@/kit/ColorModeProvider");
  return withRouter(createElement(ColorModeProvider, null, await asPerson(element))).tree;
}
const wordsInStatus = (container: HTMLElement) =>
  [...container.querySelectorAll('[role="status"]')].map((region) => region.textContent).filter(Boolean);

test("the flow page's skeleton says after 15 seconds that it takes longer than usual, and Försök igen loads the flow again", async (t) => {
  const { FlowSkeleton } = await import("../components/flow/FlowPageStates");
  const { SLOW_WAIT_MS } = await import("../components/SlowWait");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let retries = 0;
  const { container, act } = await mount(await onPage(createElement(FlowSkeleton, { onRetry: () => (retries += 1) })));
  assert.deepEqual(wordsInStatus(container), ["Laddar flödet…"]);

  await act(async () => t.mock.timers.tick(SLOW_WAIT_MS));
  assert.deepEqual(wordsInStatus(container), ["Laddar flödet…", "Det tar längre tid än vanligt."]);
  const main = container.querySelector('[role="main"]')!;
  assert.equal(main.querySelector('a[href="/flows"]')?.textContent, "Alla flöden", "the way back is in the page, not only in the bar");
  await act(async () => button(main as HTMLElement, "Försök igen")!.click());
  assert.equal(retries, 1);
});

test("an earlier run that is being opened says after 15 seconds that it takes longer than usual, and tries again on request", async (t) => {
  const { RunOpening } = await import("../components/flow/RunProgress");
  const { SLOW_WAIT_MS } = await import("../components/SlowWait");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let retries = 0;
  const { container, act } = await mount(await onPage(createElement(RunOpening, { onRetry: () => (retries += 1) })));
  assert.deepEqual(wordsInStatus(container), ["Hämtar körningen…"]);

  await act(async () => t.mock.timers.tick(SLOW_WAIT_MS));
  assert.deepEqual(wordsInStatus(container), ["Hämtar körningen…", "Det tar längre tid än vanligt."]);
  assert.equal(container.querySelector('a[href="/flows"]')?.textContent, "Alla flöden");
  await act(async () => button(container, "Försök igen")!.click());
  assert.equal(retries, 1);
});

test("a run that cannot be read while it is opened says that it tries again, at once", async () => {
  const { RunOpening } = await import("../components/flow/RunProgress");
  const { container } = await mount(await onPage(createElement(RunOpening, { onRetry: () => undefined, retrying: true })));
  assert.deepEqual(wordsInStatus(container), ["Hämtar körningen…", "Försöker igen."]);
});

test("a run on screen whose status cannot be read says that it tries again, at once, and after 15 seconds offers the ways on", async (t) => {
  const { RunProgress } = await import("../components/flow/RunProgress");
  const { SLOW_WAIT_MS } = await import("../components/SlowWait");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const props = { flowName: "Nämndmöte", steps: [], stage: "Tar fram texten", onCancel: async () => undefined };
  let retries = 0;
  const view = await mount(await onPage(createElement(RunProgress, props)));
  await view.act(async () => t.mock.timers.tick(2 * SLOW_WAIT_MS));
  assert.deepEqual(wordsInStatus(view.container), ["Tar fram texten"], "a run that is read says nothing of waiting, however long it takes");
  await view.unmount();

  const trouble = await mount(await onPage(createElement(RunProgress, { ...props, retrying: { onRetry: () => (retries += 1) } })));
  assert.deepEqual(wordsInStatus(trouble.container), ["Tar fram texten", "Försöker igen. Körningen fortsätter i Eneo."]);
  assert.equal(button(trouble.container, "Försök igen"), null, "not offered at once: it is trying");

  await trouble.act(async () => t.mock.timers.tick(SLOW_WAIT_MS));
  assert.deepEqual(wordsInStatus(trouble.container), ["Tar fram texten", "Försöker igen. Körningen fortsätter i Eneo.", "Det tar längre tid än vanligt."]);
  assert.equal(trouble.container.querySelector('a[href="/flows"]')?.textContent, "Alla flöden");
  await trouble.act(async () => button(trouble.container, "Försök igen")!.click());
  assert.equal(retries, 1);
});
