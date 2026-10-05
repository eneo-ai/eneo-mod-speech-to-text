// Runs the existing checks on a private copy, so edits and builds in the working tree cannot alter a running gate.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const CHECKS = ["lint", "unit", "backend", "dev", "real", "prod", "review", "branding", "shots"];
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}
function flag(name) {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fingerprint = (files) => hash(JSON.stringify(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
const cache = new Set([".vite", ".vite-temp", ".cache", "__pycache__"]);

function tree(root, directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (cache.has(entry.name)) continue;
    const file = join(directory, entry.name);
    if (entry.isDirectory()) tree(root, file, files);
    else files.push(relative(root, file));
  }
  return files;
}
function digest(root, name) {
  const path = join(root, name);
  return lstatSync(path).isSymbolicLink() ? hash(`link:${readlinkSync(path)}`) : hash(readFileSync(path));
}
function verify(candidate, manifest) {
  const changed = Object.entries(manifest.files).filter(([name, expected]) => !existsSync(join(candidate, name)) || digest(candidate, name) !== expected);
  const output = /^(logs\/|candidate\.json$|frontend\/tsconfig\.tsbuildinfo$|frontend\/(?:\.test-build|test-results|playwright-report|ux-shots)(?:\/|$))/;
  const builds = /^frontend\/dist(?:-check)?\//;
  // The working tree includes ignored outputs that were deliberately not captured.
  const added = manifest.status === undefined ? [] : tree(candidate, candidate)
    .filter((name) => !(name in manifest.files) && !output.test(name) && !(builds.test(name) && !manifest.assetsHash));
  if (changed.length || added.length) throw new Error(`Candidate changed: ${[...changed.map(([name]) => name), ...added].join(", ")}`);
}
function protect(candidate, files) {
  for (const name of files) {
    const path = join(candidate, name);
    if (!lstatSync(path).isSymbolicLink()) chmodSync(path, lstatSync(path).mode & ~0o222);
  }
}
function save(candidate, manifest) {
  writeFileSync(join(candidate, "candidate.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}
function sourceFiles(source) {
  const gitFiles = (...options) => execFileSync("git", ["-C", source, "ls-files", ...options, "-z"], { encoding: "utf8" }).split("\0");
  const newFiles = gitFiles("--others", "--exclude-standard").filter((name) => /^(frontend|backend|deploy|docs|docs-site|\.github)\//.test(name));
  return [...new Set([...gitFiles("--cached"), ...newFiles])]
    .filter((name) => name && !name.startsWith(".beads/") && existsSync(join(source, name)))
    .filter((name) => !name.split("/").some((part) => part === ".venv" || part === "node_modules"))
    .sort();
}
function capture(source) {
  const candidate = mkdtempSync(join(tmpdir(), "stt-candidate-"));
  try { return captureInto(source, candidate); }
  catch (error) {
    save(candidate, { source, status: "capture_failed", error: String(error) });
    throw new Error(`${error.message}; candidate: ${candidate}`);
  }
}
function captureInto(source, candidate) {
  const names = sourceFiles(source);
  const files = {};
  for (const name of names) {
    const bytes = readFileSync(join(source, name));
    mkdirSync(dirname(join(candidate, name)), { recursive: true });
    writeFileSync(join(candidate, name), bytes, { mode: lstatSync(join(source, name)).mode });
    files[name] = hash(bytes);
  }
  // Dependencies are copied too: another npm ci in the working tree must not replace a running test's modules.
  const modules = "frontend/node_modules";
  if (!existsSync(join(source, modules))) throw new Error(`Install frontend dependencies first: ${source}/frontend`);
  cpSync(join(source, modules), join(candidate, modules), {
    recursive: true, verbatimSymlinks: true,
    filter: (path) => !relative(join(source, modules), path).split(sep).some((part) => cache.has(part)),
  });
  for (const name of tree(candidate, join(candidate, modules))) {
    const path = join(candidate, name);
    if (lstatSync(path).isSymbolicLink()) {
      const target = resolve(dirname(path), readlinkSync(path));
      if (!target.startsWith(`${candidate}${sep}`)) throw new Error(`Dependency link leaves the candidate: ${name}`);
    }
    files[name] = digest(candidate, name);
  }
  // Reject a mixed capture if the workspace changed while files were copied.
  verify(source, { files });
  if (JSON.stringify(sourceFiles(source)) !== JSON.stringify(names)) throw new Error("The working tree's file list changed during capture; take a new candidate");
  const manifest = { source, createdAt: new Date().toISOString(), sourceHash: fingerprint(files), files, steps: [], status: "prepared" };
  protect(candidate, Object.keys(files));
  mkdirSync(join(candidate, "logs"));
  save(candidate, manifest);
  return { candidate, manifest };
}

let child;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  interrupted = true;
  // Only this runner's process group, including its Playwright web servers.
  if (child?.pid) {
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
});

async function run(candidate, manifest, name, command, commandArgs, cwd, env) {
  if (interrupted) throw new Error("Verification interrupted");
  verify(candidate, manifest);
  const log = join(candidate, "logs", `${name}.log`);
  const output = openSync(log, "w");
  const step = { name, startedAt: new Date().toISOString(), log, status: "running" };
  manifest.steps.push(step);
  manifest.status = "running";
  save(candidate, manifest);
  console.log(`${name}: running (${log})`);
  const exitCode = await new Promise((done, failed) => {
    child = spawn(command, commandArgs, { cwd, env, detached: true, stdio: ["ignore", output, output] });
    child.once("error", failed);
    child.once("exit", (code) => done(code ?? 1));
  }).catch((error) => { step.status = "failed"; step.error = String(error); throw error; })
    .finally(() => { closeSync(output); child = undefined; });
  step.exitCode = exitCode;
  step.finishedAt = new Date().toISOString();
  step.status = exitCode === 0 ? "passed" : "failed";
  save(candidate, manifest);
  verify(candidate, manifest);
  if (exitCode !== 0 || interrupted) throw new Error(`${name} failed; see ${log}`);
  console.log(`${name}: passed`);
}

async function main() {
  if (flag("--help")) {
    console.log("npm run verify:candidate -- [--checks lint,unit,backend,dev,real,prod,review,branding,shots] [--grep <Playwright pattern>] [--workers 2] [--app-port 4051] [--stub-port 9051]\n--prepare-only captures without running. --source selects a working tree. --verify <candidate> checks its recorded inputs and assets. --status <candidate> reads a compact receipt without verifying hashes.\nThe default runs every listed check and the full screenshot matrix. Candidates and reports remain in the printed temporary directory.");
    return;
  }
  const reporting = option("--status");
  if (reporting) {
    if (args.length) throw new Error(`Unknown arguments: ${args.join(" ")}`);
    const manifest = JSON.parse(readFileSync(join(reporting, "candidate.json"), "utf8"));
    const steps = (manifest.steps ?? []).map((step) => {
      const report = join(reporting, "frontend/test-results", `${step.name}.json`);
      const stats = step.finishedAt && existsSync(report) ? JSON.parse(readFileSync(report, "utf8")).stats : undefined;
      return {
        name: step.name, status: step.status, exitCode: step.exitCode ?? null,
        startedAt: step.startedAt, finishedAt: step.finishedAt ?? null, log: step.log,
        tests: stats ? { passed: stats.expected, failed: stats.unexpected, flaky: stats.flaky, skipped: stats.skipped } : null,
      };
    });
    console.log(JSON.stringify({
      candidate: resolve(reporting), source: manifest.source, createdAt: manifest.createdAt,
      sourceHash: manifest.sourceHash, assetsHash: manifest.assetsHash ?? null,
      status: manifest.status, selection: manifest.selection, error: manifest.error ?? null, steps,
    }, null, 2));
    return;
  }
  const checking = option("--verify");
  if (checking) {
    if (args.length) throw new Error(`Unknown arguments: ${args.join(" ")}`);
    verify(checking, JSON.parse(readFileSync(join(checking, "candidate.json"), "utf8")));
    console.log("Candidate unchanged");
    return;
  }
  const source = resolve(option("--source", join(import.meta.dirname, "../..")));
  const prepare = flag("--prepare-only");
  const checks = option("--checks", CHECKS.join(",")).split(",");
  const grep = option("--grep");
  const workers = Number(option("--workers", "2"));
  const app = Number(option("--app-port", process.env.A11Y_APP_PORT ?? "4051"));
  const stub = Number(option("--stub-port", process.env.A11Y_STUB_PORT ?? "9051"));
  if (args.length || checks.some((name) => !CHECKS.includes(name)) || new Set(checks).size !== checks.length) throw new Error("Unknown or duplicate check/argument; use --help");
  if (!Number.isInteger(workers) || workers < 1 || workers > 4) throw new Error("--workers must be 1 to 4");
  if (![app, stub].every((port) => Number.isInteger(port) && port >= 1024 && port <= 65533) || [app, app + 1, app + 2].includes(stub)) throw new Error("Use distinct app/stub ports between 1024 and 65533");
  if (!prepare) console.log(`Capturing ${source}`);
  const { candidate, manifest } = capture(source);
  manifest.selection = { checks, grep: grep ?? null, workers, appPort: app, stubPort: stub };
  save(candidate, manifest);
  if (prepare) { console.log(JSON.stringify({ candidate, sourceHash: manifest.sourceHash })); return; }
  console.log(`Candidate: ${candidate}\nSource: ${manifest.sourceHash}`);
  const frontend = join(candidate, "frontend");
  const localPython = join(source, "backend/.venv/bin/python");
  const env = { ...process.env, CI: "1", PYTHONDONTWRITEBYTECODE: "1", A11Y_APP_PORT: String(app), A11Y_STUB_PORT: String(stub), BACKEND_PYTHON: process.env.BACKEND_PYTHON ?? (existsSync(localPython) ? localPython : "python3") };
  for (const name of ["GATE_TARGET", "STATIC_DIR", "STUB_BRANDING", "SPEAKER_REVIEW_ENABLED", "REAL_EXTERNAL_URL", "PROD_EXTERNAL_URL", "STUB_URL", "UX_SHOTS_DIR", "SHOTS_SIZES"]) delete env[name];
  const invoke = (name, command, argv, cwd = frontend, extra = {}) => run(candidate, manifest, name, command, argv, cwd, { ...env, ...extra });
  try {
    for (const name of ["lint", "unit", "backend"].filter((name) => checks.includes(name))) {
      if (name === "backend") await invoke(name, env.BACKEND_PYTHON, ["-m", "unittest", "discover", "-s", "tests"], join(candidate, "backend"));
      else await invoke(name, "npm", ["run", name === "unit" ? "test" : "lint"]);
    }
    if (checks.some((name) => !["lint", "unit", "backend"].includes(name))) {
      await invoke("build", "npm", ["run", "build"]);
      await invoke("build-check", "npm", ["run", "build:check"]);
      for (const build of ["dist", "dist-check"]) {
        const names = tree(candidate, join(frontend, build));
        for (const name of names) manifest.files[name] = digest(candidate, name);
        protect(candidate, names);
      }
      manifest.assetsHash = fingerprint(Object.fromEntries(Object.entries(manifest.files).filter(([name]) => /^frontend\/dist(?:-check)?\//.test(name))));
      save(candidate, manifest);
    }
    const playwright = (name, config = "playwright.config.ts", extra = {}) => invoke(name, "npx", ["--no-install", "playwright", "test", "--config", config, `--workers=${workers}`, `--output=test-results/${name}`, "--reporter=list,json,html", ...(grep ? ["--grep", grep] : [])], frontend, { PLAYWRIGHT_JSON_OUTPUT_NAME: join(frontend, "test-results", `${name}.json`), PLAYWRIGHT_HTML_OUTPUT_DIR: join(frontend, "test-results", `${name}-report`), PLAYWRIGHT_HTML_OPEN: "never", ...extra });
    for (const name of CHECKS.filter((name) => checks.includes(name) && !["lint", "unit", "backend"].includes(name))) {
      if (name === "dev") await playwright(name);
      if (name === "real") await playwright(name, "playwright.config.ts", { GATE_TARGET: "real", STATIC_DIR: join(frontend, "dist-check") });
      if (name === "prod") await playwright(name, "playwright.prod.config.ts");
      if (name === "review") await playwright(name, "playwright.review.config.ts", { SPEAKER_REVIEW_ENABLED: "true" });
      if (name === "branding") for (const brand of ["custom", "name"]) await playwright(`branding-${brand}`, "playwright.branding.config.ts", { STUB_BRANDING: brand });
      if (name === "shots") {
        await playwright(name, "playwright.shots.config.ts", { UX_SHOTS_DIR: join(frontend, "ux-shots", "candidate") });
        await invoke("shots-index", process.execPath, ["scripts/ux-shots.mjs", "--index", "candidate"]);
      }
    }
    manifest.status = "passed";
  } catch (error) {
    manifest.status = interrupted ? "interrupted" : "failed";
    manifest.error = String(error);
    throw error;
  } finally { save(candidate, manifest); }
  console.log(`Verification passed: ${join(candidate, "candidate.json")}`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
