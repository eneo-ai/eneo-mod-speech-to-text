import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// The review page with the speaker review on: `npm run test:a11y:review`. The setting is fixed when the app starts
// (SPEAKER_REVIEW_ENABLED, the build constant the Vite config reads), so it is a different app, started with it on here;
// the gate's own has it off. review-flag.spec.ts reads the same variable, which the script sets.
const PROJECTS = ["phone-320-light", "laptop-1440-light"];

export default defineConfig({
  ...base,
  outputDir: "test-results/review-flag",
  testMatch: /review-flag\.spec\.ts/,
  workers: 1,
  reporter: [["list"]],
  projects: (base.projects ?? []).filter((project) => PROJECTS.includes(project.name ?? "")),
  // An app already listening on the port was started without the setting: refuse it rather than test nothing.
  webServer: (Array.isArray(base.webServer) ? base.webServer : []).map((server, index) => ({
    ...server,
    // The second server is the app.
    env: index === 1 ? { ...server.env, SPEAKER_REVIEW_ENABLED: "true" } : server.env,
    reuseExistingServer: false,
  })),
});
