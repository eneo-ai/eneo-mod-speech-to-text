import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";

// The accessibility gate: `npm run test:a11y`. The app runs in `next dev` against
// the stub backend in tests/e2e, so no Eneo is needed. Next allows one dev
// server per checkout: stop your own `npm run dev` here first.
const APP = 3401;
const STUB = 8401;

type Use = NonNullable<PlaywrightTestConfig["use"]>;
const phone = (width: number, height: number): Use => ({
  viewport: { width, height },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
});
const laptop: Use = { viewport: { width: 1440, height: 900 } };
// Every project scans every state (a11y.spec); keyboard walks and screen-reader snapshots run where they differ.
const scanOnly = /(keyboard|aria)\.spec\.ts/;
const noSnapshots = /aria\.spec\.ts/;

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results/a11y",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  reporter: [["list"], ["html", { open: "never", outputFolder: "test-results/a11y-report" }]],
  use: {
    baseURL: `http://127.0.0.1:${APP}`,
    // Full Chromium rather than the headless shell: it has the PDF viewer the result's preview opens.
    channel: "chromium",
    locale: "sv-SE",
    timezoneId: "Europe/Stockholm",
    permissions: ["microphone"],
    launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
    trace: "retain-on-failure",
  },
  projects: [
    { name: "phone-320-light", use: { ...phone(320, 568), colorScheme: "light" }, testIgnore: noSnapshots },
    { name: "phone-320-dark", use: { ...phone(320, 568), colorScheme: "dark" }, testIgnore: scanOnly },
    { name: "phone-390-light", use: { ...phone(390, 844), colorScheme: "light" } },
    { name: "phone-390-dark", use: { ...phone(390, 844), colorScheme: "dark" }, testIgnore: scanOnly },
    { name: "laptop-1440-light", use: { ...laptop, colorScheme: "light" } },
    { name: "laptop-1440-dark", use: { ...laptop, colorScheme: "dark" }, testIgnore: scanOnly },
    // 200 % zoom of a 1280 × 800 window.
    { name: "zoom-200", use: { viewport: { width: 640, height: 400 }, deviceScaleFactor: 2, colorScheme: "light" }, testIgnore: noSnapshots },
    { name: "forced-colors", use: { ...laptop, colorScheme: "light", forcedColors: "active" }, testIgnore: noSnapshots },
    { name: "reduced-motion", use: { ...phone(390, 844), colorScheme: "light", reducedMotion: "reduce" }, testIgnore: scanOnly },
  ],
  webServer: [
    {
      command: `python3 tests/e2e/stub-server.py ${STUB}`,
      url: `http://127.0.0.1:${STUB}/api/auth/status`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `npx next dev -H 127.0.0.1 -p ${APP}`,
      url: `http://127.0.0.1:${APP}/`,
      env: { INTERNAL_API_BASE: `http://127.0.0.1:${STUB}`, NEXT_TELEMETRY_DISABLED: "1" },
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
