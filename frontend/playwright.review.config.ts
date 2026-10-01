import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// The review page with the speaker review on: `npm run test:a11y:review`. The setting is read when the app is built
// (NEXT_PUBLIC_), so it is a different app, started with it set by the script; the gate's own has it off.
const PROJECTS = ["phone-320-light", "laptop-1440-light"];

export default defineConfig({
  ...base,
  outputDir: "test-results/review-flag",
  testMatch: /review-flag\.spec\.ts/,
  workers: 1,
  reporter: [["list"]],
  projects: (base.projects ?? []).filter((project) => PROJECTS.includes(project.name ?? "")),
  // An app already listening on the port was built without the setting: refuse it rather than test nothing.
  webServer: (Array.isArray(base.webServer) ? base.webServer : []).map((server) => ({ ...server, reuseExistingServer: false })),
});
