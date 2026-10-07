/**
 * The screenshot sweep behind `npm run ux:shots` (scripts/ux-shots.mjs): every gate state (tests/e2e/screens.ts) at
 * every size of the device matrix, in both colour modes, for review by eye. Nothing here fails on what it sees.
 *
 * A state is reached once per device class and colour mode, at the class's first size where it exists, and then the
 * window is resized through the class's other sizes: what a person sees who turns the device or resizes the window.
 * Each size writes the first screen, then a full-page picture after all sizes have their first screen:
 * ux-shots/<label>/<state>/<width>x<height>-<mode>.first.png and …-<mode>.png.
 */
import { mkdirSync } from "node:fs";
import { expect, test, type TestInfo } from "@playwright/test";
import { STATES } from "../e2e/screens";

export type DeviceClass = "phone" | "tablet" | "desktop";

/** The owner's matrix: phones upright and on their side, tablets both ways, laptops, desktop and wide screens. */
export const SIZES: [DeviceClass, number, number][] = [
  ["phone", 320, 568],
  ["phone", 375, 667],
  ["phone", 390, 844],
  ["phone", 412, 915],
  ["phone", 568, 320],
  ["phone", 667, 375],
  ["phone", 844, 390],
  ["phone", 915, 412],
  ["tablet", 768, 1024],
  ["tablet", 820, 1180],
  ["tablet", 1024, 1366],
  ["tablet", 1024, 768],
  ["tablet", 1180, 820],
  ["tablet", 1366, 1024],
  // A window just narrower than the laptop layout.
  ["desktop", 1000, 800],
  ["desktop", 1280, 800],
  ["desktop", 1366, 768],
  ["desktop", 1440, 900],
  ["desktop", 1536, 864],
  ["desktop", 1920, 1080],
  ["desktop", 2560, 1440],
  ["desktop", 3440, 1440],
  ["desktop", 3840, 2160],
];

const OUT = process.env.UX_SHOTS_DIR;
// SHOTS_SIZES=1000x800,1440x900 narrows the sweep to those sizes.
const PICK = process.env.SHOTS_SIZES?.split(",").map((size) => size.trim());

/** The test info a state's `only` reads, for a size other than the project's. */
const at = (info: TestInfo, width: number, height: number) =>
  ({ ...info, project: { ...info.project, use: { ...info.project.use, viewport: { width, height } } } }) as TestInfo;

for (const state of STATES) {
  test(state.name, async ({ page }, info) => {
    if (!OUT) throw new Error("UX_SHOTS_DIR is not set: run `npm run ux:shots`.");
    const [device, mode] = info.project.name.split("-") as [DeviceClass, string];
    const sizes = SIZES.filter(
      ([kind, width, height]) =>
        kind === device && (!PICK || PICK.includes(`${width}x${height}`)) && (!state.only || state.only(at(info, width, height))),
    );
    test.skip(sizes.length === 0, "no size of this class has the state");
    const [, firstWidth, firstHeight] = sizes[0];
    await page.setViewportSize({ width: firstWidth, height: firstHeight });
    await state.go(page, at(info, firstWidth, firstHeight));
    mkdirSync(`${OUT}/${state.name}`, { recursive: true });
    // The gallery is reviewed for layout, not pixel equality. Keep clocks and levels visible: an opaque mask can cover
    // the warning beside a timer, or a dialog placed in front of the waveform.
    for (const [, width, height] of sizes) {
      await page.setViewportSize({ width, height });
      // Two frames for the layout to follow the new size, then what fades in at the new size.
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      await page.waitForTimeout(250);
      const base = `${OUT}/${state.name}/${width}x${height}-${mode}`;
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "the viewport picture keeps the device's pointer").toBe(Boolean(info.project.use.hasTouch));
      await page.screenshot({ path: `${base}.first.png`, animations: "disabled" });
    }
    // Chromium's full-page capture can reset touch emulation. Capture every real viewport before taking full pages;
    // fixed layers and touch density in a full-page image are context, not proof of their viewport geometry.
    for (const [, width, height] of sizes) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(250);
      const base = `${OUT}/${state.name}/${width}x${height}-${mode}`;
      await page.screenshot({ path: `${base}.png`, fullPage: true, animations: "disabled" });
    }
  });
}
