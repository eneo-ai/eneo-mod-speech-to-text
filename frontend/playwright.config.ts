import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";

// The accessibility gate: `npm run test:a11y`. The app runs on the Vite dev server against
// the stub backend in tests/e2e, so no Eneo is needed. The server is this run's own, on its own port, so your own
// `npm run dev` (3002) can stay up.
//
// Its real target, `npm run test:a11y:real` (GATE_TARGET=real): the same states and specs on the built UI (`dist-check/`,
// from `npm run build:check`) served by the real backend (`python -m app.serve`) under the strict policy, with the stub
// as Eneo. Every test then has a session of its own and the sentinel (tests/e2e/gate.ts). REAL_EXTERNAL_URL runs it
// against a backend that is already up (the image behind Traefik) instead of starting one; the stub is then that
// deployment's Eneo, at the address the browser can reach.
// One pair of ports per checkout, so several worktrees can run the gate at the same time: set A11Y_APP_PORT and
// A11Y_STUB_PORT to a pair no other run uses. The defaults are for a single checkout.
const APP = Number(process.env.A11Y_APP_PORT ?? 3401);
const STUB = Number(process.env.A11Y_STUB_PORT ?? 8401);
const REAL = process.env.GATE_TARGET === "real";
const EXTERNAL = process.env.REAL_EXTERNAL_URL;
// Specs that need what only the dev server has, or that replace the live socket in the browser and so would skip the relay
// they are meant to exercise: the dialog-leak fixture (leaks), routeWebSocket (live-sheet, recording-short), the review
// build (review-flag) and another deployment (branding). A file, not a skip at run time, and no title changes.
const DEV_ONLY = /(leaks|live-sheet|recording-short|review-flag|branding)\.spec\.ts/;

type Use = NonNullable<PlaywrightTestConfig["use"]>;
// A touch screen: Chromium then matches (pointer: coarse) and (hover: none).
const touch = (width: number, height: number): Use => ({
  viewport: { width, height },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
});
const laptop: Use = { viewport: { width: 1440, height: 900 } };
// A desktop screen, a mouse.
const wide = (width: number, height: number): Use => ({ viewport: { width, height } });
// Every project scans every state (a11y.spec); keyboard walks and screen-reader snapshots run where they differ.
const scanOnly = /(keyboard|aria|names|harness)\.spec\.ts/;
const noSnapshots = /(aria|names|harness)\.spec\.ts/;

// The sentinel's own tests cause what it watches for, so they need it, and the real target.
const SENTINEL_SPEC = /sentinel\.spec\.ts/;

/** The projects as they run on the target: the real one leaves out the dev-only specs, the dev profile the sentinel's. */
const forTarget = (projects: NonNullable<PlaywrightTestConfig["projects"]>) =>
  projects.map((project) => ({ ...project, testIgnore: [project.testIgnore ?? [], REAL ? DEV_ONLY : SENTINEL_SPEC].flat() }));

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results/a11y",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  // One dev server serves every worker: more than four starve it on a shared host, and a page
  // still loading then fails a check that is not about accessibility.
  workers: 4,
  reporter: [["list"], ["html", { open: "never", outputFolder: "test-results/a11y-report" }]],
  use: {
    baseURL: REAL ? (EXTERNAL ?? `http://127.0.0.1:${APP}`) : `http://127.0.0.1:${APP}`,
    // Full Chromium rather than the headless shell: it has the PDF viewer the result's preview opens.
    channel: "chromium",
    locale: "sv-SE",
    timezoneId: "Europe/Stockholm",
    permissions: ["microphone"],
    launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: forTarget([
    { name: "phone-320-light", use: { ...touch(320, 568), colorScheme: "light" }, testIgnore: noSnapshots },
    { name: "phone-320-dark", use: { ...touch(320, 568), colorScheme: "dark" }, testIgnore: scanOnly },
    { name: "phone-390-light", use: { ...touch(390, 844), colorScheme: "light" } },
    { name: "phone-390-dark", use: { ...touch(390, 844), colorScheme: "dark" }, testIgnore: scanOnly },
    { name: "tablet-portrait", use: { ...touch(768, 1024), isMobile: false, colorScheme: "light" }, testIgnore: scanOnly },
    { name: "tablet-landscape", use: { ...touch(1024, 768), isMobile: false, colorScheme: "light" }, testIgnore: scanOnly },
    // A window just narrower than the laptop layout (1024 px): one column at its widest.
    { name: "laptop-1000-light", use: { ...wide(1000, 800), colorScheme: "light" }, testIgnore: scanOnly },
    // The small laptop: 1280 × 800.
    { name: "laptop-1280-light", use: { ...wide(1280, 800), colorScheme: "light" }, testIgnore: noSnapshots },
    { name: "laptop-1280-dark", use: { ...wide(1280, 800), colorScheme: "dark" }, testIgnore: scanOnly },
    { name: "laptop-1440-light", use: { ...laptop, colorScheme: "light" } },
    { name: "laptop-1440-dark", use: { ...laptop, colorScheme: "dark" }, testIgnore: scanOnly },
    // 200 % zoom of a 1280 × 800 window.
    { name: "zoom-200", use: { viewport: { width: 640, height: 400 }, deviceScaleFactor: 2, colorScheme: "light" }, testIgnore: noSnapshots },
    { name: "forced-colors", use: { ...laptop, colorScheme: "light", forcedColors: "active" }, testIgnore: noSnapshots },
    // Every per-state scan on every desktop width; keyboard order and focus management do not change past
    // 1920, so the keyboard walks and dialog focus tests run there only.
    { name: "ultrawide-1920-light", use: { ...wide(1920, 1080), colorScheme: "light" }, testIgnore: noSnapshots },
    { name: "ultrawide-1920-dark", use: { ...wide(1920, 1080), colorScheme: "dark" }, testIgnore: scanOnly },
    { name: "ultrawide-2560-light", use: { ...wide(2560, 1440), colorScheme: "light" }, testIgnore: scanOnly },
    { name: "ultrawide-2560-dark", use: { ...wide(2560, 1440), colorScheme: "dark" }, testIgnore: scanOnly },
    { name: "ultrawide-3440-light", use: { ...wide(3440, 1440), colorScheme: "light" }, testIgnore: scanOnly },
    { name: "ultrawide-3440-dark", use: { ...wide(3440, 1440), colorScheme: "dark" }, testIgnore: scanOnly },
    { name: "reduced-motion", use: { ...touch(390, 844), colorScheme: "light", reducedMotion: "reduce" }, testIgnore: scanOnly },
  ]),
  webServer: [
    {
      command: `python3 tests/e2e/stub-server.py ${STUB}`,
      url: `http://127.0.0.1:${STUB}/api/auth/status`,
      reuseExistingServer: !process.env.CI,
    },
    ...(REAL
      ? EXTERNAL
        ? []
        : [
            {
              // The real backend on the built UI, as the image runs it, with the stub as its Eneo.
              command: "node tests/prod/start-backend.mjs",
              url: `http://127.0.0.1:${APP}/health`,
              env: { BACKEND_PORT: String(APP), STUB_URL: `http://127.0.0.1:${STUB}` },
              timeout: 60_000,
              reuseExistingServer: !process.env.CI,
            },
          ]
      : [
          {
            command: `npx vite --host 127.0.0.1 --port ${APP} --strictPort`,
            url: `http://127.0.0.1:${APP}/`,
            // The speaker review is off in the gate's own app; playwright.review.config.ts starts one with it on.
            env: { DEV_API_BASE: `http://127.0.0.1:${STUB}`, SPEAKER_REVIEW_ENABLED: "false" },
            timeout: 120_000,
            reuseExistingServer: !process.env.CI,
          },
        ]),
  ],
});
