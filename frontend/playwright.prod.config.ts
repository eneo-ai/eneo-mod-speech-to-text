import { defineConfig } from "@playwright/test";

// The production build in every engine the module supports: `npm run test:prod`. It proves what the gate's
// `next dev` cannot: the built stylesheets' order, the built theme, and the page under the production CSP.
const APP = 3411;
const STUB = 8411;

export default defineConfig({
  testDir: "tests/prod",
  outputDir: "test-results/prod",
  timeout: 60_000,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${APP}`, locale: "sv-SE", colorScheme: "light", viewport: { width: 1280, height: 800 }, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
    { name: "firefox", use: { browserName: "firefox" } },
  ],
  webServer: [
    { command: `python3 tests/e2e/stub-server.py ${STUB}`, url: `http://127.0.0.1:${STUB}/api/auth/status`, reuseExistingServer: false },
    {
      command: `npm run build && npx next start -H 127.0.0.1 -p ${APP}`,
      url: `http://127.0.0.1:${APP}/`,
      env: { INTERNAL_API_BASE: `http://127.0.0.1:${STUB}`, FOUNDATION_CHECK: "1", NEXT_TELEMETRY_DISABLED: "1" },
      timeout: 300_000,
      reuseExistingServer: false,
    },
  ],
});
