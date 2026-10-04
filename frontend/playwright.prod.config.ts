import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

// The built UI, served by the real backend (`python -m app.serve`, started by tests/prod/start-backend.mjs) in front of the
// fake Eneo (tests/e2e/stub-server.py): `npm run test:prod`. Three backends, because a build holds what its tests expect:
//   shipped   dist/        what ships: every test not tagged below, in three engines
//   fixture   dist-check/  the same build with the development pages (the foundation check): the `@fixture` tests
//   branded   dist/        a deployment with an organisation of its own (name, logo, green accent): the `@branded` tests
// A test says which it is in its title; no test asks a build for what it does not contain. `@chromium` marks what only
// that engine can do (tests/prod/weight.spec.ts reads each request's transfer size).
// PROD_EXTERNAL_URL replaces the shipped backend with one that is already running (the image, deploy/acceptance); its
// Eneo is then the stub the caller started, named by STUB_URL (tests/prod/upstream.spec.ts reads what that stub received).
// Ports: A11Y_APP_PORT, +1 and +2 for the three backends, and A11Y_STUB_PORT (defaults 3411 to 3413 and 8411), so that
// several checkouts can run at once.
const APP = Number(process.env.A11Y_APP_PORT ?? 3411);
const STUB = Number(process.env.A11Y_STUB_PORT ?? 8411);
const EXTERNAL = process.env.PROD_EXTERNAL_URL;
const address = (port: number) => `http://127.0.0.1:${port}`;

process.env.STUB_URL ??= address(STUB); // the workers inherit it

/** A real backend on a build, in front of the stub; `organisation` is the deployment's own variables, if it has any. */
const backend = (port: number, build: string, organisation: Record<string, string> = {}) => ({
  command: "node tests/prod/start-backend.mjs",
  url: `${address(port)}/health`,
  env: { BACKEND_PORT: String(port), STUB_URL: address(STUB), STATIC_DIR: resolve(build), ...organisation },
  reuseExistingServer: false,
});

const logo = (file: string) => resolve("tests/fixtures", file);
const NOT_SHIPPED = /@fixture|@branded/;

export default defineConfig({
  testDir: "tests/prod",
  outputDir: "test-results/prod",
  timeout: 60_000,
  reporter: [["list"]],
  use: { locale: "sv-SE", colorScheme: "light", viewport: { width: 1280, height: 800 }, trace: "retain-on-failure" },
  projects: [
    { name: "shipped-chromium", grepInvert: NOT_SHIPPED, use: { browserName: "chromium", baseURL: EXTERNAL ?? address(APP) } },
    { name: "shipped-webkit", grepInvert: new RegExp(`${NOT_SHIPPED.source}|@chromium`), use: { browserName: "webkit", baseURL: EXTERNAL ?? address(APP) } },
    { name: "shipped-firefox", grepInvert: new RegExp(`${NOT_SHIPPED.source}|@chromium`), use: { browserName: "firefox", baseURL: EXTERNAL ?? address(APP) } },
    { name: "fixture", grep: /@fixture/, use: { browserName: "chromium", baseURL: address(APP + 1) } },
    { name: "branded", grep: /@branded/, use: { browserName: "chromium", baseURL: address(APP + 2) } },
  ],
  webServer: [
    { command: `python3 tests/e2e/stub-server.py ${STUB}`, url: `${address(STUB)}/__stub/stats`, reuseExistingServer: false },
    ...(EXTERNAL ? [] : [backend(APP, "dist")]),
    backend(APP + 1, "dist-check"),
    backend(APP + 2, "dist", {
      ORGANIZATION_NAME: "Förvaltningen för kultur, fritid och samhällsbyggnad i Västernorrlands län",
      ORGANIZATION_LOGO: logo("brand-wide-light.svg"),
      ORGANIZATION_LOGO_DARK: logo("brand-wide-dark.svg"),
      ORGANIZATION_ACCENT: "#1E7B34",
    }),
  ],
});
