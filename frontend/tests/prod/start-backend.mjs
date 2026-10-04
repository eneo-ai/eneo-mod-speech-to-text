// Starts the real backend the way the image runs it (`python -m app.serve`) on a built UI, in front of the fake Eneo
// (tests/e2e/stub-server.py). It stays in the foreground, which is what Playwright's `webServer` wants; Playwright's
// `url` is the wait for /health, and a backend that cannot start (no index.html in STATIC_DIR) ends this process with
// the backend's own message.
//
//   BACKEND_PORT  the port to listen on (required)
//   STUB_URL      the origin of the fake Eneo (required); the backend reaches Eneo there and sends the browser there to sign in
//   STATIC_DIR    the built UI (default dist-check/, from `npm run build:check`)
//   BACKEND_PYTHON  default backend/.venv/bin/python when it exists, else python3
//
// Everything else of the environment passes through, so a deployment's ORGANIZATION_* variables are simply set.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const frontend = new URL("../../", import.meta.url);
const backend = new URL("../backend/", frontend);
const { BACKEND_PORT: port, STUB_URL: stub } = process.env;
if (!port || !stub) {
  console.error("start-backend: BACKEND_PORT and STUB_URL are required");
  process.exit(2);
}
const venv = fileURLToPath(new URL(".venv/bin/python", backend));
const python = process.env.BACKEND_PYTHON ?? (existsSync(venv) ? venv : "python3");

const child = spawn(python, ["-m", "app.serve", "--host", "127.0.0.1", "--port", port], {
  cwd: fileURLToPath(backend),
  stdio: "inherit",
  env: {
    // The stub's own defaults for the module and the service key; the same variables are the stub's.
    MODULE_KEY: "speech-to-text",
    ENEO_API_KEY: "stub-service-key",
    SESSION_SECRET: "s".repeat(48),
    COOKIE_SECURE: "false",
    ...process.env,
    STATIC_DIR: process.env.STATIC_DIR ?? fileURLToPath(new URL("dist-check/", frontend)),
    ENEO_BACKEND_URL: stub,
    ENEO_PUBLIC_URL: stub,
    MODULE_PUBLIC_URL: `http://127.0.0.1:${port}`,
  },
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
