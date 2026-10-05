import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// The screenshot sweep: `npm run ux:shots` (scripts/ux-shots.mjs), on the gate's own app and stub. One project per
// device class and colour mode; tests/shots/shots.spec.ts resizes each through the class's sizes. Pictures at one CSS
// pixel per pixel, so a run of the whole matrix stays a size a disk and a reviewer can hold.
const DEVICES = {
  phone: { hasTouch: true, isMobile: true },
  tablet: { hasTouch: true, isMobile: false },
  desktop: {},
};

export default defineConfig({
  ...base,
  testDir: "tests/shots",
  outputDir: "test-results/shots-run",
  timeout: 300_000,
  retries: 1,
  reporter: [["list"]],
  use: { ...base.use, trace: "off", screenshot: "off", deviceScaleFactor: 1 },
  projects: Object.entries(DEVICES).flatMap(([device, use]) =>
    (["light", "dark"] as const).map((colorScheme) => ({ name: `${device}-${colorScheme}`, use: { ...use, colorScheme } })),
  ),
});
