import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";
import { firefoxEnv } from "./tests/firefox-home";

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
const WORKERS = 4;
// Specs that need what only the dev server has, or that replace the live socket in the browser and so would skip the relay
// they are meant to exercise: the dialog-leak fixture (leaks), routeWebSocket (live-sheet, recording-short), the review
// build (review-flag), another deployment (branding) and browser contexts of its own, which the real target does not sign in
// (controls). A file, not a skip at run time, and no title changes.
const DEV_ONLY = /(leaks|live-sheet|recording-short|review-flag|branding|controls)\.spec\.ts/;
// The engine a project runs in: Chromium unless it says otherwise.
const engineOf = (project: { use?: Use }) => project.use?.browserName ?? "chromium";

type Use = NonNullable<PlaywrightTestConfig["use"]>;
// A touch screen: Chromium then matches (pointer: coarse) and (hover: none).
const touch = (width: number, height: number): Use => ({
  viewport: { width, height },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
});
const laptop: Use = { viewport: { width: 1440, height: 900 } };
// WebKit and Firefox, each with its microphone its own way (Chromium's is the shared `use` below: the permission and two
// launch arguments). A project cannot unset the shared `channel`, so each names its engine's own build.
// WebKit takes the permission and answers with its mock device. It records on a Mac; Playwright's WebKit for Linux has
// no MediaRecorder, and the app's upload-only setup is what the gate expects there (`records` in tests/e2e/screens.ts).
const webkit: Use = { browserName: "webkit", channel: "webkit", launchOptions: {} };
// Firefox has no microphone permission to grant in Playwright: two preferences give a fake stream without the question,
// and a third keeps what the tests play out of the speakers. WebKit's build has no such switch. On a Mac it needs a home
// of its own (tests/firefox-home.ts).
const firefox: Use = {
  browserName: "firefox",
  channel: "firefox",
  permissions: [],
  launchOptions: {
    firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true, "media.volume_scale": "0.0" },
    ...firefoxEnv(),
  },
};
// A desktop screen, a mouse.
const wide = (width: number, height: number): Use => ({ viewport: { width, height } });
// Every project scans every state (a11y.spec). The keyboard walks, the press on every control (controls.spec, by far the
// longest) and the screen-reader snapshots run where they differ: each list is what a project leaves out.
const specs = (...names: string[]) => new RegExp(`(${names.join("|")})\\.spec\\.ts`);
const scanOnly = specs("keyboard", "controls", "aria", "names", "harness");
const noSnapshots = specs("controls", "aria", "names", "harness");
// A tablet is a finger on a laptop's layout (landscape) or on the stacked one at its widest (portrait): its own walks and presses.
const walksAndControls = specs("aria", "names", "harness");
// The checks' own tests (harness.spec) run once in each engine, on its laptop.
const noHarness = specs("harness");
// What another engine can change, and so what its projects run: the scan, the keyboard walks, the press on every control
// and the screen-reader snapshots. The behaviour specs stay Chromium's; they are about the module's logic, and several
// need what only Chromium has (the DevTools protocol, its fake devices, going offline).
const portable = ["a11y", "keyboard", "controls", "aria"];
// What the module does only for Safari's engine on a touch screen, an iPhone's and an iPad's: its WebKit touch projects run it.
const touchSafari = "touch-pdf";

// The sentinel's own tests cause what it watches for, so they need it, and the real target.
const SENTINEL_SPEC = /sentinel\.spec\.ts/;

/**
 * The projects as they run on the target: the real one leaves out the dev-only specs, the dev profile the sentinel's.
 * The real target is Chromium's alone: the built app in three engines is the production tests' (playwright.prod.config.ts).
 */
const forTarget = (projects: NonNullable<PlaywrightTestConfig["projects"]>) =>
  projects
    .filter((project) => !REAL || engineOf(project) === "chromium")
    .map((project) => ({ ...project, testIgnore: [project.testIgnore ?? [], REAL ? DEV_ONLY : SENTINEL_SPEC].flat() }));

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results/a11y",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  // One dev server serves every worker: more than four starve it on a shared host, and a page
  // still loading then fails a check that is not about accessibility.
  workers: WORKERS,
  reporter: [["list"], ["html", { open: "never", outputFolder: "test-results/a11y-report" }]],
  use: {
    baseURL: REAL ? (EXTERNAL ?? `http://127.0.0.1:${APP}`) : `http://127.0.0.1:${APP}`,
    // Full Chromium rather than the headless shell: it has the PDF viewer the result's preview opens.
    channel: "chromium",
    locale: "sv-SE",
    timezoneId: "Europe/Stockholm",
    // A list of permissions denies every one it leaves out. A browser keeps the screen on for a page in view without
    // asking, and the recorder says when it does not: the screen's wake lock is granted as it is there.
    permissions: ["microphone", "screen-wake-lock"],
    // The fake microphone records a tone, and the tests that play a recording would send it to the speakers: the output
    // device is muted, and playback runs as it does with sound.
    launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--mute-audio"] },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: forTarget([
    { name: "phone-320-light", use: { ...touch(320, 568), colorScheme: "light" }, testIgnore: noSnapshots },
    { name: "phone-320-dark", use: { ...touch(320, 568), colorScheme: "dark" }, testIgnore: scanOnly },
    { name: "phone-390-light", use: { ...touch(390, 844), colorScheme: "light" }, testIgnore: noHarness },
    { name: "phone-390-dark", use: { ...touch(390, 844), colorScheme: "dark" }, testIgnore: scanOnly },
    { name: "tablet-portrait", use: { ...touch(768, 1024), isMobile: false, colorScheme: "light" }, testIgnore: walksAndControls },
    { name: "tablet-landscape", use: { ...touch(1024, 768), isMobile: false, colorScheme: "light" }, testIgnore: walksAndControls },
    // A phone on its side: wide as a tablet, as low as 200 % zoom; its name keeps it out of the phone-only expectations.
    { name: "landscape-844", use: { ...touch(844, 390), colorScheme: "light" }, testIgnore: scanOnly },
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
    // The other engines, as engine checks and not as the products built on them (Playwright's WebKit is ahead of Safari):
    // WebKit where an iPhone, an iPad and a Mac have it, Firefox on a laptop. The tablet has no snapshots, as Chromium's.
    { name: "phone-390-webkit", use: { ...touch(390, 844), ...webkit, colorScheme: "light" }, testMatch: specs(...portable, touchSafari) },
    { name: "tablet-landscape-webkit", use: { ...touch(1024, 768), isMobile: false, ...webkit, colorScheme: "light" }, testMatch: specs("a11y", "keyboard", "controls", touchSafari) },
    { name: "laptop-1440-webkit", use: { ...laptop, ...webkit, colorScheme: "light" }, testMatch: specs(...portable, "harness") },
    { name: "laptop-1440-firefox", use: { ...laptop, ...firefox, colorScheme: "light" }, testMatch: specs(...portable, "harness") },
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
              // Concurrent UI tests need separate upload slots. Backend tests exercise saturation at the production default.
              env: { BACKEND_PORT: String(APP), STUB_URL: `http://127.0.0.1:${STUB}`, MAX_CONCURRENT_UPLOADS: String(WORKERS) },
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
