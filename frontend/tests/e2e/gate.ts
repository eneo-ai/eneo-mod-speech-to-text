import { expect } from "@playwright/test";
import { test as signedIn } from "./auth";
import { REAL, Sentinel } from "./sentinel";

// GATE_CPU=8 makes each page's main thread that many times slower (Chromium's own throttle), so a race that only a slow
// CI runner loses is lost here too, without loading the machine: `GATE_CPU=8 npx playwright test leaks.spec.ts`.
// It slows the test's own page before the test touches it; a page a spec opens in a context of its own (the controls
// sweep) is not slowed, and other engines have no such throttle.
const CPU = Number(process.env.GATE_CPU ?? 1);
if (!Number.isFinite(CPU) || CPU < 1) throw new Error(`GATE_CPU is a number of 1 or more (how many times slower), not "${process.env.GATE_CPU}".`);

/**
 * The `test` of the gate's specs. On the dev profile it is Playwright's own. On the real target (`GATE_TARGET=real`: the
 * built UI served by the real backend under the strict policy, the stub as Eneo) every test also gets
 *
 * - a session of its own, made through the real handshake (tests/e2e/auth.ts), so a test that signs out, or lets the
 *   login end, ends only its own; and
 * - the sentinel (tests/e2e/sentinel.ts): any policy violation or redirect, and any console error or failed request
 *   that the test did not declare, fails it.
 */
export const test = signedIn.extend<{ session_: void; sentinel: Sentinel; slow_: void }>({
  slow_: [
    async ({ page, browserName }, use, info) => {
      if (browserName !== "chromium") throw new Error("GATE_CPU slows Chromium only: run it with a Chromium project.");
      await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: CPU });
      info.annotations.push({ type: "cpu", description: `${CPU} times slower` });
      await use();
    },
    { auto: CPU > 1 },
  ],
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
