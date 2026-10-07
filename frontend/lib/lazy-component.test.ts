import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";

import { button, cleanup, installDom, mount } from "./test-dom";

installDom();
afterEach(cleanup);

/** A piece of code that arrives when the test says so, or is refused. */
function gate<T>() {
  const calls: { resolve(value: T): void; reject(error: Error): void }[] = [];
  const get = () => new Promise<T>((resolve, reject) => void calls.push({ resolve, reject }));
  return { get, calls };
}

/** What a page that uses the code sees, as text: the value, or the failure. */
async function show<T extends string>(loader: import("./lazy-component").Loader<T>) {
  const { useLoaded } = await import("./lazy-component");
  let latest!: ReturnType<typeof useLoaded<T>>;
  function Probe() {
    latest = useLoaded(loader);
    return createElement("p", null, latest.value ?? (latest.failed ? "failed" : "waiting"));
  }
  const view = await mount(createElement(Probe));
  return { ...view, text: () => view.container.textContent, state: () => latest };
}

const settle = (view: { act: (callback: () => Promise<void>) => Promise<void> }) => view.act(async () => new Promise<void>((resolve) => setTimeout(resolve, 5)));

test("the code arrives, the page has it, and the next page has it at once", async () => {
  const { lazyLoader } = await import("./lazy-component");
  const { get, calls } = gate<string>();
  const loader = lazyLoader(get);
  const first = await show(loader);
  assert.equal(first.text(), "waiting");
  await first.act(async () => calls[0].resolve("kod"));
  assert.equal(first.text(), "kod");
  const second = await show(loader);
  assert.equal(second.text(), "kod", "no waiting for what is already here");
  assert.equal(calls.length, 1, "fetched once");
});

test("two pages that ask while it is on its way share one fetch", async () => {
  const { lazyLoader } = await import("./lazy-component");
  const { get, calls } = gate<string>();
  const loader = lazyLoader(get);
  const a = await show(loader);
  const b = await show(loader);
  assert.equal(calls.length, 1);
  await a.act(async () => calls[0].resolve("kod"));
  assert.equal(a.text(), "kod");
  assert.equal(b.text(), "kod");
});

test("when the code cannot be fetched the page says so, and asks nothing more: a browser keeps a failed fetch, so the only way is the person's reload", async () => {
  const { lazyLoader } = await import("./lazy-component");
  const { get, calls } = gate<string>();
  const loader = lazyLoader(get);
  const view = await show(loader);
  await view.act(async () => calls[0].reject(new TypeError("Failed to fetch dynamically imported module")));
  assert.equal(view.text(), "failed");
  await settle(view);
  assert.equal(calls.length, 1, "no second fetch, by itself or by a press");
  assert.deepEqual(Object.keys(view.state()).sort(), ["failed", "value"], "there is no retry to press");
});

test("a failure is kept: another page that asks later has it at once, and nothing is fetched again", async () => {
  const { lazyLoader } = await import("./lazy-component");
  const { get, calls } = gate<string>();
  const loader = lazyLoader(get);
  const first = await show(loader);
  await first.act(async () => calls[0].reject(new Error("gone")));
  await first.unmount();
  const second = await show(loader);
  await settle(second);
  assert.equal(second.text(), "failed");
  assert.equal(calls.length, 1);
});

test("where code could not be fetched there is one action, the person's own reload, and nothing reloads by itself", async () => {
  const { LoadFailure } = await import("../components/LoadFailure");
  let reloads = 0;
  const view = await mount(createElement(LoadFailure, { reload: () => void (reloads += 1), keeps: "Det du har skrivit finns kvar.", children: "Granskningsverktygen kunde inte läsas in." }));
  assert.equal(view.container.querySelector('[role="status"]')?.textContent, "Granskningsverktygen kunde inte läsas in. Det du har skrivit finns kvar.");
  assert.deepEqual([...view.container.querySelectorAll("button")].map((b) => b.textContent?.trim()), ["Ladda om sidan"], "one action");
  await settle(view);
  assert.equal(reloads, 0, "not by itself");
  await view.act(async () => button(view.container, "Ladda om sidan")!.click());
  assert.equal(reloads, 1, "on the press");

  const plain = await mount(createElement(LoadFailure, { reload: () => undefined, children: "Kalendern kunde inte läsas in." }));
  assert.equal(plain.container.querySelector('[role="status"]')?.textContent, "Kalendern kunde inte läsas in.", "no promise where there is none to make");
});

test("code that arrives for a loader the page no longer asks is not shown as the new one's", async () => {
  const { lazyLoader, useLoaded } = await import("./lazy-component");
  const old = gate<string>();
  const next = gate<string>();
  function Page({ loader }: { loader: import("./lazy-component").Loader<string> }) {
    return createElement("p", null, useLoaded(loader).value ?? "waiting");
  }
  const oldLoader = lazyLoader(old.get);
  const nextLoader = lazyLoader(next.get);
  const view = await mount(createElement(Page, { loader: oldLoader }));
  await view.act(async () => view.rerender(createElement(Page, { loader: nextLoader })));
  await view.act(async () => old.calls[0].resolve("gammal"));
  assert.equal(view.container.textContent, "waiting");
  await view.act(async () => next.calls[0].resolve("ny"));
  assert.equal(view.container.textContent, "ny");
});

test("code that is a component survives being stored as state", async () => {
  const { lazyLoader, useLoaded } = await import("./lazy-component");
  const Greeting = () => createElement("b", null, "Hej");
  const loader = lazyLoader(async () => Greeting);
  function Page() {
    const { value: Loaded } = useLoaded(loader);
    return Loaded ? createElement(Loaded) : createElement("i", null, "väntar");
  }
  const view = await mount(createElement(Page));
  await settle(view);
  assert.equal(view.container.textContent, "Hej");
});
