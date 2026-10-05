/**
 * The recording's controls are one toolbar named for the recording: Pausa and Stoppa are one Tab stop and the arrow keys
 * move between them, and with Strömma the status and the timer are in it too. Each control keeps the house's target size.
 */
import { expect, test } from "./gate";
import { STATES } from "./screens";

for (const state of ["recording", "stromma"]) {
  test(`${state}: Pausa and Stoppa are one Tab stop in a toolbar, and the arrows move between them`, async ({ page }, info) => {
    await STATES.find((s) => s.name === state)!.go(page, info);
    const bar = page.getByRole("toolbar", { name: "Inspelningen" });
    await expect(bar).toBeVisible();
    const pausa = bar.getByRole("button", { name: "Pausa" });
    const stoppa = bar.getByRole("button", { name: "Stoppa" });
    if (state === "stromma") await expect(bar, "the status and the timer are in the toolbar").toContainText(/Spelar in\s*\d+:\d\d/);

    await pausa.focus();
    await page.keyboard.press("ArrowRight");
    await expect(stoppa).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(pausa).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(stoppa, "focus is remembered: this is the toolbar's one Tab stop").toBeFocused();
    await page.keyboard.press("Tab");
    expect(await bar.evaluate((element) => element.contains(document.activeElement)), "Tab leaves the toolbar").toBe(false);
    await page.keyboard.press("Shift+Tab");
    await expect(stoppa, "and comes back to where focus was").toBeFocused();

    for (const button of [pausa, stoppa]) {
      const box = (await button.boundingBox())!;
      expect(Math.min(box.width, box.height), "the house's 44 px target").toBeGreaterThanOrEqual(44);
    }
  });
}

for (const state of ["disk-full", "silent-microphone", "time-left-5"]) {
  test(`${state}: the timer can be read above the controls on a short portrait screen`, async ({ page }, info) => {
    test.skip(!info.project.name.startsWith("phone-320-"), "the short portrait screen");
    await STATES.find((s) => s.name === state)!.go(page, info);
    const timer = page.getByText(/^\d+:\d\d$/).first();
    await timer.scrollIntoViewIfNeeded();
    await expect.poll(() => timer.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= innerHeight && [2, box.height / 2, box.height - 2].every((offset) => {
        const top = document.elementFromPoint(box.x + box.width / 2, box.y + offset);
        return !!top && (element.contains(top) || top.contains(element));
      });
    }), "the timer is whole and uncovered after scrolling to it").toBe(true);
    for (const name of ["Pausa", "Stoppa"]) await expect(page.getByRole("button", { name, exact: true })).toBeInViewport();
  });
}
