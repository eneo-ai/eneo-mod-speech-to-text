/**
 * Counts how many times React renders a component, from outside the app, so a test can say that an interaction reached
 * a few components and not thousands. A count does not drift with the machine's speed the way a time does.
 *
 * It stands in for React DevTools. React finds `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` when react-dom loads, calls its
 * `inject(renderer)`, and after every commit its `onCommitFiberRoot(rendererID, root)`. From `root.current` this walks the
 * fibers the way DevTools does (the same rule as its `didFiberRender`):
 *
 * - a fiber with no alternate is new in this commit, and was rendered;
 * - a function component (tag 0, or tag 15 for a memo of a plain function) rendered when its `PerformedWork` flag (1) is
 *   set. A memo that bails out is cloned without the flag, so it is not counted;
 * - a subtree whose `child` is the alternate's was not visited by the commit, and is not walked.
 *
 * The component is found by its function's name, which the dev server keeps. Production builds minify it, so the spec
 * that uses this runs on the dev profile only.
 */
import { expect, test, type Page } from "@playwright/test";

interface Counter {
  injected: boolean;
  commits: number;
  renders: number;
  error: string | null;
}
type Win = typeof globalThis & { __renderCounter: Counter };

function installHook(name: string) {
  const counter: Counter = { injected: false, commits: 0, renders: 0, error: null };
  (window as unknown as Win).__renderCounter = counter;
  interface Fiber {
    tag: number;
    type: unknown;
    flags: number;
    child: Fiber | null;
    sibling: Fiber | null;
    alternate: Fiber | null;
  }
  const isTarget = (fiber: Fiber) => (fiber.tag === 0 || fiber.tag === 15) && typeof fiber.type === "function" && (fiber.type as { name: string }).name === name;
  const mounted = (fiber: Fiber) => {
    if (isTarget(fiber)) counter.renders++;
    for (let child = fiber.child; child; child = child.sibling) mounted(child);
  };
  const updated = (next: Fiber, previous: Fiber) => {
    if (isTarget(next) && (next.flags & 1) === 1) counter.renders++;
    if (next.child === previous.child) return;
    for (let child = next.child; child; child = child.sibling) {
      if (child.alternate) updated(child, child.alternate);
      else mounted(child);
    }
  };
  const renderers = new Map();
  (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers,
    inject(renderer: unknown) {
      counter.injected = true;
      renderers.set(renderers.size + 1, renderer);
      return renderers.size;
    },
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      try {
        counter.commits++;
        const current = root.current;
        if (current.alternate) updated(current, current.alternate);
        else mounted(current);
      } catch (error) {
        counter.error = String(error);
      }
    },
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    setStrictMode() {},
  };
}

/**
 * Starts counting the renders of the component `name` in `page`: call it before the page is opened. `renders()` is the
 * count since the last `reset()`; `settled()` waits until no render has come for a while, so a render that React defers
 * (a deferred value, a transition) is counted before the count is read.
 */
export async function countRenders(page: Page, name: string) {
  await page.addInitScript(installHook, name);
  const renders = async () => {
    const counter = await page.evaluate(() => ({ ...(window as unknown as Win).__renderCounter }));
    // Never a silent zero: a count that cannot see React says so.
    if (!counter.injected || counter.commits === 0 || counter.error) {
      throw new Error(
        `The render counting broke, so a count of ${counter.renders} means nothing: React ${counter.injected ? "injected into" : "never found"} the DevTools hook, ` +
          `${counter.commits} commits were seen${counter.error ? `, and the walk failed: ${counter.error}` : ""}. Check the fiber tags and flags in tests/e2e/react-renders.ts against the React version.`,
      );
    }
    return counter.renders;
  };
  return {
    renders,
    reset: () => page.evaluate(() => void ((window as unknown as Win).__renderCounter.renders = 0)),
    settled: async () => {
      let last = -1;
      let quiet = 0;
      await expect
        .poll(
          async () => {
            const now = await renders();
            quiet = now === last ? quiet + 1 : 0;
            last = now;
            return quiet;
          },
          { message: `${name} was still rendering`, intervals: [100], timeout: 30_000 },
        )
        .toBeGreaterThanOrEqual(4);
      test.info().annotations.push({ type: "renders", description: `${name}: ${last}` });
      return last;
    },
  };
}
