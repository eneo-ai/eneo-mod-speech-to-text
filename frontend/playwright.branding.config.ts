import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// The branding states of the gate: `npm run test:a11y:branding`. A deployment with an organisation of its own (a long
// name, wide logos or none, a green accent) is a different stub, not a different page: the page reads who it shows
// from the backend, so it is the stub that is started as that deployment (STUB_BRANDING, set by the script) and the
// states named branding-* (tests/e2e/screens.ts) that exist only then. Same ports as the gate's.
const PROJECTS = ["phone-320-light", "phone-390-dark", "laptop-1440-light", "zoom-200", "forced-colors"];

export default defineConfig({
  ...base,
  outputDir: "test-results/branding",
  // Playwright tests this against "project file title": the states are named branding-*, and every test of branding.spec.ts
  // is the branded deployment's own.
  grep: /branding[-.]/,
  workers: 2,
  reporter: [["list"]],
  projects: (base.projects ?? []).filter((project) => PROJECTS.includes(project.name ?? "")),
  // A stub already listening on the port is somebody's default one: refuse it rather than test nothing.
  webServer: (Array.isArray(base.webServer) ? base.webServer : []).map((server, index) => ({ ...server, reuseExistingServer: index === 0 ? false : server.reuseExistingServer })),
});
