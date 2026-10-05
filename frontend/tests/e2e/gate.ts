import { expect } from "@playwright/test";
import { test as signedIn } from "./auth";
import { REAL, Sentinel } from "./sentinel";

/**
 * The `test` of the gate's specs. On the dev profile it is Playwright's own. On the real target (`GATE_TARGET=real`: the
 * built UI served by the real backend under the strict policy, the stub as Eneo) every test also gets
 *
 * - a session of its own, made through the real handshake (tests/e2e/auth.ts), so a test that signs out, or lets the
 *   login end, ends only its own; and
 * - the sentinel (tests/e2e/sentinel.ts): any policy violation or redirect, and any console error or failed request
 *   that the test did not declare, fails it.
 */
export const test = signedIn.extend<{ session_: void; sentinel: Sentinel }>({
  // Pulling in `session` signs the context in, so this is auto on the real target only.
  session_: [async ({ session }, use) => (void session, use()), { auto: REAL }],
  sentinel: [
    // `page` first: the sentinel is torn down, and judges, before the page is closed, whose teardown aborts what is in flight.
    async ({ context, page }, use) => {
      void page;
      const sentinel = new Sentinel();
      if (REAL) await sentinel.watch(context);
      await use(sentinel);
      if (REAL) sentinel.assertClean();
    },
    { auto: REAL },
  ],
});

export { expect };
