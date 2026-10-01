/**
 * The old dialogs open in 250 ms and close in 150 ms (the module's motion scale). Their tokens are namespaced
 * (`--module-duration-*`) because the design system declares `--duration-fast` (175 ms) in a layer above the module's
 * base styles; an un-namespaced token was silently overridden and opened every dialog 30 % faster.
 * This spec goes away with the Radix dialogs in Phase 8.
 */
import { expect, test } from "@playwright/test";
import { STATES } from "./screens";

test.beforeEach(({}, info) => test.skip(info.project.name !== "laptop-1440-light", "one width is enough"));

test("a Radix dialog and its backdrop open in 250 ms, whatever the design system declares", async ({ page }, info) => {
  await STATES.find((state) => state.name === "ready-delete-dialog")!.go(page, info);
  const open = await page.evaluate(() => {
    const duration = (selector: string) => {
      const element = document.querySelector(selector);
      return element ? getComputedStyle(element).animationDuration : null;
    };
    return { dialog: duration('[role="alertdialog"]'), backdrop: duration(".t-overlay") };
  });
  expect(open).toEqual({ dialog: "0.25s", backdrop: "0.25s" });
});
