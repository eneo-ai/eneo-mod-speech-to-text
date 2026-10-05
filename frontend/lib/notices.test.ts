import assert from "node:assert/strict";
import test, { afterEach, type TestContext } from "node:test";
import { createElement } from "react";

import { OfflineBanner, type OfflineWaiting } from "../components/OfflineBanner";
import { RetryNotice } from "../components/RetryNotice";
import { ProblemAlert } from "../components/flow/ProblemAlert";
import { onlineStatus } from "./online-status";
import type { Problem } from "./flow-session";
import { button, cleanup, installDom, mount } from "./test-dom";
import { withRouter } from "./test-router";

installDom();
afterEach(async () => {
  await cleanup();
  onlineStatus.reportReachable();
});

const alerts = (container: HTMLElement) => [...container.querySelectorAll('[role="alert"]')];

test("a problem with only a title is one alert holding the words, and offers nothing to press", async () => {
  const { container } = await mount(createElement(ProblemAlert, { problem: { title: "Det gick inte att skicka." } }));
  const [alert, ...others] = alerts(container);
  assert.deepEqual(others, [], "one alert");
  assert.equal(alert.textContent?.trim(), "Det gick inte att skicka.");
  assert.equal(container.querySelectorAll("button, a").length, 0, "no row of actions");
  assert.equal(container.querySelectorAll("h1, h2, h3, h4, h5, h6").length, 0, "words, not a heading in the page's outline");
});

test("a problem with a detail says both, in that order, and still enters the outline as no heading", async () => {
  const { container } = await mount(createElement(ProblemAlert, { problem: { title: "Flödena kunde inte visas.", detail: "Servern kunde inte nås just nu." } }));
  const text = alerts(container)[0].textContent ?? "";
  assert.ok(text.indexOf("Flödena kunde inte visas.") >= 0 && text.indexOf("Servern kunde inte nås just nu.") > text.indexOf("Flödena kunde inte visas."));
  assert.equal(container.querySelectorAll("h1, h2, h3, h4, h5, h6").length, 0);
});

test("Försök igen is offered only when trying again can help and there is something to call", async () => {
  let calls = 0;
  const onRetry = () => void calls++;
  const retryable: Problem = { title: "Det gick inte.", retry: true };
  const withButton = await mount(createElement(ProblemAlert, { problem: retryable, onRetry }));
  await withButton.act(async () => button(withButton.container, "Försök igen")!.click());
  assert.equal(calls, 1, "the button calls what it was given");
  await withButton.unmount();

  const noCallback = await mount(createElement(ProblemAlert, { problem: retryable }));
  assert.equal(button(noCallback.container, "Försök igen"), null, "nothing to call");
  await noCallback.unmount();
  const notRetryable = await mount(createElement(ProblemAlert, { problem: { title: "Det gick inte.", retry: false }, onRetry }));
  assert.equal(button(notRetryable.container, "Försök igen"), null, "trying again cannot help");
});

test("a long reason with no way to retry is shown whole", async () => {
  const detail = "Flödena kan inte visas eftersom tjänsten saknar en inställning. ".repeat(3).trim();
  const { container } = await mount(createElement(ProblemAlert, { problem: { title: "Flödena kunde inte visas.", detail, retry: false } }));
  assert.ok(alerts(container)[0].textContent?.includes(detail));
  assert.equal(container.querySelectorAll("button").length, 0);
});

test("the way back to the flows is offered when the problem asks for it", async () => {
  const { container } = await mount(withRouter(createElement(ProblemAlert, { problem: { title: "Flödet finns inte längre.", back: true } })).tree);
  const back = [...container.querySelectorAll("a")].find((link) => link.textContent?.trim() === "Alla flöden");
  assert.equal(back?.getAttribute("href"), "/flows");
});

/** What the alert is asked to scroll into view, and how. */
function scrolled(t: TestContext) {
  const calls: { element: Element; options: unknown }[] = [];
  const original = window.Element.prototype.scrollIntoView;
  window.Element.prototype.scrollIntoView = function (this: Element, options?: boolean | ScrollIntoViewOptions) {
    calls.push({ element: this, options });
  };
  t.after(() => {
    window.Element.prototype.scrollIntoView = original;
  });
  return calls;
}

/** A root the test can render into again, to see what a new problem or the same one does. */
async function host(t: TestContext) {
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  t.after(async () => {
    await act(async () => root.unmount());
    element.remove();
  });
  return { container: element, render: (ui: ReturnType<typeof createElement>) => act(async () => root.render(ui)) };
}

test("an alert that is to be revealed scrolls into view once per problem, with a jump", async (t) => {
  const calls = scrolled(t);
  const { container, render } = await host(t);
  const first: Problem = { title: "Det gick inte att skapa dokumentet." };
  await render(createElement(ProblemAlert, { problem: first, reveal: true }));
  assert.deepEqual(calls.map((call) => call.options), [{ block: "nearest", behavior: "instant" }]);
  assert.ok(calls[0].element.contains(alerts(container)[0]), "the alert itself");
  await render(createElement(ProblemAlert, { problem: first, reveal: true }));
  assert.equal(calls.length, 1, "the same problem drawn again is not scrolled to again");
  await render(createElement(ProblemAlert, { problem: { title: "Det gick inte igen." }, reveal: true }));
  assert.equal(calls.length, 2, "another problem is");
});

test("an alert that need not be revealed stays where it is", async (t) => {
  const calls = scrolled(t);
  const quiet = await host(t);
  await quiet.render(createElement(ProblemAlert, { problem: { title: "Ingen scroll." } }));
  assert.equal(calls.length, 0);
  const revealed = await host(t);
  await revealed.render(createElement(ProblemAlert, { problem: { title: "Scrolla." }, reveal: true }));
  assert.deepEqual(calls.map((call) => call.options), [{ block: "nearest", behavior: "instant" }]);
});

const wait = (retryAt: number | null, retryNow = () => {}) => ({ retryAt, retryNow });

test("without a wait the notice is only an empty status region, there for the change to be announced in", async () => {
  const { container } = await mount(createElement(RetryNotice, { wait: null }));
  const status = [...container.querySelectorAll('[role="status"]')];
  assert.equal(status.length, 1);
  assert.equal(status[0].textContent, "");
  assert.equal(container.querySelectorAll("button").length, 0);
});

test("a waiting send says it in one sentence in the live region, and the countdown stays outside it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  let now = 0;
  const { container, act } = await mount(createElement(RetryNotice, { wait: wait(1_000_000 + 5_000, () => void now++) }));
  const [status] = container.querySelectorAll('[role="status"]');
  assert.equal(status.textContent, "Det gick inte att skicka just nu. Försöker igen automatiskt.");
  const countdown = [...container.querySelectorAll("p")].find((p) => p.textContent?.includes(" s."));
  assert.equal(countdown?.textContent?.trim(), "Det gick inte att skicka just nu. Försöker igen om 5 s.");
  assert.equal(status.contains(countdown ?? null), false, "the live region does not tick");

  await act(async () => t.mock.timers.tick(2_000));
  assert.match(countdown?.textContent ?? "", /om 3 s\./);
  // Past the time it only says 0: never a negative number.
  await act(async () => t.mock.timers.tick(10_000));
  assert.match(countdown?.textContent ?? "", /om 0 s\./);

  await act(async () => button(container, "Försök nu")!.click());
  assert.equal(now, 1, "Försök nu tries at once");
});

test("a send that has stopped trying by itself says so, with no countdown, and Försök igen tries at once", async () => {
  let tried = 0;
  const { container, act } = await mount(createElement(RetryNotice, { wait: wait(null, () => void tried++) }));
  const [status] = container.querySelectorAll('[role="status"]');
  assert.equal(status.textContent, "Det går fortfarande inte att skicka.");
  assert.match(container.textContent ?? "", /Det går fortfarande inte att skicka\. Försök igen när du vill\./);
  assert.doesNotMatch(container.textContent ?? "", / s\./, "no countdown");
  await act(async () => button(container, "Försök igen")!.click());
  assert.equal(tried, 1);
});

test("the countdown's timer is stopped when the notice goes", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  const live = new Set<unknown>();
  const [set, clear] = [globalThis.setInterval, globalThis.clearInterval];
  globalThis.setInterval = ((...args: Parameters<typeof set>) => {
    const id = set(...args);
    live.add(id);
    return id;
  }) as typeof set;
  globalThis.clearInterval = ((id: Parameters<typeof clear>[0]) => {
    live.delete(id);
    return clear(id);
  }) as typeof clear;
  t.after(() => Object.assign(globalThis, { setInterval: set, clearInterval: clear }));
  const { unmount } = await mount(createElement(RetryNotice, { wait: wait(1_005_000) }));
  assert.equal(live.size, 1, "one timer while it waits");
  await unmount();
  assert.equal(live.size, 0, "none after");
});

const MESSAGES: [OfflineWaiting, string][] = [
  ["recording", "Ingen anslutning. Inspelningen fortsätter."],
  ["upload", "Ingen anslutning. Uppladdningen fortsätter när anslutningen är tillbaka."],
  ["run", "Ingen anslutning. Körningen fortsätter i Eneo och visas här när anslutningen är tillbaka."],
  [null, "Ingen anslutning."],
];

test("while online the offline notice is an empty status region; offline it says what waits, in the same region", async () => {
  const { container, act } = await mount(createElement(OfflineBanner, { waiting: "run" }));
  const status = container.querySelector('[role="status"]')!;
  assert.equal(container.querySelectorAll('[role="status"]').length, 1);
  assert.equal(status.textContent, "");
  assert.equal(status.getAttribute("aria-label"), null, "no name");
  assert.equal(status.children.length, 0, "no children");

  await act(async () => onlineStatus.reportNetworkFailure());
  assert.equal(container.querySelector('[role="status"]'), status, "the region was there before, so the change is announced");
  assert.equal(status.textContent, "Ingen anslutning. Körningen fortsätter i Eneo och visas här när anslutningen är tillbaka.");

  await act(async () => onlineStatus.reportReachable());
  assert.equal(status.textContent, "");
  assert.equal(status.children.length, 0);
});

test("the offline notice says what waits for each thing that can", async () => {
  for (const [waiting, words] of MESSAGES) {
    onlineStatus.reportNetworkFailure();
    const { container, unmount } = await mount(createElement(OfflineBanner, { waiting }));
    assert.equal(container.querySelector('[role="status"]')?.textContent, words, `${waiting}`);
    await unmount();
    onlineStatus.reportReachable();
  }
});
