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
 * The components are found by their functions' names, which the dev server keeps. Production builds minify them, so the
 * specs that use this run on the dev profile only.
 */
import { expect, test, type Page } from "@playwright/test";

interface Counter {
  injected: boolean;
  commits: number;
  renders: Record<string, number>;
  error: string | null;
}
type Win = typeof globalThis & { __renderCounter: Counter };

function installHook(names: string[]) {
  const counter: Counter = { injected: false, commits: 0, renders: Object.fromEntries(names.map((name) => [name, 0])), error: null };
  (window as unknown as Win).__renderCounter = counter;
  interface Fiber {
    tag: number;
    type: unknown;
    flags: number;
    child: Fiber | null;
    sibling: Fiber | null;
    alternate: Fiber | null;
  }
  const count = (fiber: Fiber) => {
    if ((fiber.tag !== 0 && fiber.tag !== 15) || typeof fiber.type !== "function") return;
    const name = (fiber.type as { name: string }).name;
    if (name in counter.renders) counter.renders[name]++;
  };
  const mounted = (fiber: Fiber) => {
    count(fiber);
    for (let child = fiber.child; child; child = child.sibling) mounted(child);
  };
  const updated = (next: Fiber, previous: Fiber) => {
    if ((next.flags & 1) === 1) count(next);
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
 * Starts counting the renders of the components `names` in `page`: call it once, before the page is opened. `renders(name)`
 * is the count since the last `reset()` (of the first name when none is given); `settled(name)` waits until no render of
 * it has come for a while, so a render that React defers (a deferred value, a transition) is counted before the count is
 * read.
 */
export async function countRenders(page: Page, ...names: [string, ...string[]]) {
  await page.addInitScript(installHook, names);
  const renders = async (name = names[0]) => {
    const counter = await page.evaluate(() => ({ ...(window as unknown as Win).__renderCounter }));
    // Never a silent zero: a count that cannot see React says so.
    if (!counter.injected || counter.commits === 0 || counter.error) {
      throw new Error(
        `The render counting broke, so a count of ${counter.renders[name]} means nothing: React ${counter.injected ? "injected into" : "never found"} the DevTools hook, ` +
          `${counter.commits} commits were seen${counter.error ? `, and the walk failed: ${counter.error}` : ""}. Check the fiber tags and flags in tests/e2e/react-renders.ts against the React version.`,
      );
    }
    return counter.renders[name];
  };
  return {
    renders,
    reset: () =>
      page.evaluate(() => {
        const counted = (window as unknown as Win).__renderCounter.renders;
        for (const name in counted) counted[name] = 0;
      }),
    settled: async (name = names[0]) => {
      let last = -1;
      let quiet = 0;
      await expect
        .poll(
          async () => {
            const now = await renders(name);
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
