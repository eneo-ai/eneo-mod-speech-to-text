// The performance check of the built UI, on a phone profile and a laptop profile with a throttled CPU, behind the real
// backend (`python -m app.serve`) in front of the fake Eneo (tests/e2e/stub-server.py), as tests/prod runs them.
//
//   npm run build && npm run perf               a run, labelled with the short commit (and -dirty for changed files)
//   npm run perf -- --name before                the label gets a name: <sha>-before
//   npm run perf -- --label before               the label exactly
//   npm run perf -- --runs 5                     runs per profile (default 3); every number is the median of them
//   npm run perf -- --compare <before> <after>   two runs side by side, with the difference
//   ... --compare <before> <after> --fail-on-regression   exit 1 when <after> has a CLS or an INP clearly worse than <before>
//
// It builds nothing: dist/ comes from `npm run build`. Ports: A11Y_APP_PORT (the backend, default 3421) and A11Y_STUB_PORT
// (the fake Eneo, default 8421); BACKEND_PYTHON as for tests/prod/start-backend.mjs.
//
// Measured per profile (tests/perf/budget.json holds the budgets):
//   per page (list, setup, result, review)  LCP, CLS and total blocking time of a load with an empty cache, and the INP of
//                                           a fixed list of interactions on that page
//   list -> flow                            the time from the click on a flow to its setup page
//   long transcript                         INP of the filter, search and correction on the run with 2,000 passages
// CLS and INP are stable and fail the run when over budget (exit 2, apart from a run that broke, exit 1); LCP, blocking
// time and times are reported, since a shared machine moves them. A run writes test-results/perf/<label>.json (ignored by git).
// .github/workflows/perf.yml measures a pull request's base and head on the same runner and compares them with
// --fail-on-regression: a number is worth failing on only relative to the other side of the same machine and minute.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const FRONTEND = resolve(import.meta.dirname, "..");
const OUT = join(FRONTEND, "test-results", "perf");
const args = process.argv.slice(2);
const servers = [];

/** Takes `--flag value` out of the arguments. */
function option(flag, count = 1) {
  const at = args.indexOf(flag);
  if (at < 0) return null;
  const values = args.splice(at, count + 1).slice(1);
  if (values.length !== count || values.some((value) => value.startsWith("--"))) fail(`${flag} takes ${count} value(s).`);
  return count === 1 ? values[0] : values;
}

function fail(message) {
  console.error(message);
  for (const { child } of servers) child.kill("SIGTERM");
  process.exit(1);
}

const read = (path) => JSON.parse(readFileSync(join(FRONTEND, path), "utf8"));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

// What is shown. A metric is a number per profile; CLS is unitless.
const format = (metric, value) => (value === undefined ? "" : metric.unit === "" ? value.toFixed(3) : String(Math.round(value)));
const rowsOf = (metrics) => {
  const rows = new Map();
  for (const metric of metrics) {
    const row = rows.get(`${metric.group} ${metric.name}`) ?? { metric, values: {} };
    row.values[metric.profile] = metric.median;
    rows.set(`${metric.group} ${metric.name}`, row);
  }
  return [...rows];
};
const table = (head, lines) => {
  const widths = head.map((cell, i) => Math.max(cell.length, ...lines.map((line) => line[i].length)));
  const show = (line) => line.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join("  ");
  console.log([show(head), show(widths.map((width) => "-".repeat(width))), ...lines.map(show)].join("\n"));
};

// A CLS or an INP is a regression when it is worse than before by more than the fraction AND by more than the amount (ms; CLS is
// unitless): the fraction spares a small number on a small base, the amount spares a frame of jitter on a large one. An INP that
// stays within Web Vitals' good (200 ms) is not one: a CI runner moves a laptop's 60 to 150 ms by more than that amount with
// nothing changed (72 -> 144 and 64 -> 136 ms on a pull request that touched no product code).
const REGRESSION = { cls: [0.3, 0.02, 0], inp: [0.3, 40, 200], inpLong: [0.3, 40, 200] };
const regressed = (kind, before, after) => {
  const [fraction, amount, floor] = REGRESSION[kind] ?? [];
  return amount !== undefined && after > floor && after - before > amount && after > before * (1 + fraction);
};

const pair = option("--compare", 2);
if (pair) {
  const gate = args.includes("--fail-on-regression");
  if (gate) args.splice(args.indexOf("--fail-on-regression"), 1);
  if (args.length) fail(`Unknown argument: ${args.join(" ")}`);
  const [a, b] = pair.map((label) => {
    const file = join(OUT, `${label}.json`);
    if (!existsSync(file)) fail(`No run labelled ${label} in ${OUT}.`);
    return JSON.parse(readFileSync(file, "utf8"));
  });
  const second = new Map(rowsOf(b.metrics));
  const lines = [];
  const worse = [];
  for (const [key, { metric, values }] of rowsOf(a.metrics)) {
    for (const profile of Object.keys(values)) {
      const other = second.get(key)?.values[profile];
      const delta = other === undefined ? "" : (other - values[profile]).toFixed(metric.unit === "" ? 3 : 0);
      lines.push([`${profile} ${key}`, format(metric, values[profile]), format(metric, other), delta]);
      if (gate && other !== undefined && regressed(metric.kind, values[profile], other))
        worse.push(`${profile} ${key} ${format(metric, values[profile])} -> ${format(metric, other)}`);
    }
  }
  table(["metric", pair[0], pair[1], "change"], lines);
  if (worse.length) {
    console.error(`\n${worse.length} worse in ${pair[1]} than in ${pair[0]}: ${worse.join("; ")}`);
    process.exit(1);
  }
  process.exit(0);
}

const runs = Number(option("--runs") ?? 3);
if (!Number.isInteger(runs) || runs < 1) fail("--runs takes a whole number.");
const name = option("--name");
const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim() !== "";
const label =
  option("--label") ?? [execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() + (dirty ? "-dirty" : ""), name].filter(Boolean).join("-");
if (!/^[\w.-]+$/.test(label)) fail(`A label is letters, digits, dots and dashes: ${label}`);
if (args.length) fail(`Unknown argument: ${args.join(" ")}`);
if (!existsSync(join(FRONTEND, "dist", "index.html"))) fail("There is no dist/. Run `npm run build` first.");

const budget = read("tests/perf/budget.json");
const ids = read("tests/fixtures/ids.json");
const APP = Number(process.env.A11Y_APP_PORT ?? 3421);
const STUB = Number(process.env.A11Y_STUB_PORT ?? 8421);
const BASE = `http://127.0.0.1:${APP}`;

// The servers, as tests/prod starts them; their output is kept for the failure that needs it.
function serve(command, argv, env) {
  const child = spawn(command, argv, { cwd: FRONTEND, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  const output = [];
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => output.push(chunk));
  const server = { child, output, exited: new Promise((done) => child.on("exit", done)) };
  servers.push(server);
  return server;
}
async function ready(server, url) {
  const give = Date.now() + 60_000;
  while (Date.now() < give) {
    if (server.child.exitCode !== null) fail(`${url}: the server ended.\n${Buffer.concat(server.output)}`);
    if (await fetch(url).then((response) => response.ok, () => false)) return;
    await new Promise((done) => setTimeout(done, 200));
  }
  fail(`${url}: no answer within 60 s.\n${Buffer.concat(server.output)}`);
}
async function stopServers() {
  for (const { child } of servers) child.kill("SIGTERM");
  await Promise.all(servers.map(({ exited }) => exited));
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stopServers().then(() => process.exit(1)));

// In the page: layout shifts, the longest tasks, the last largest paint and the events that took longer than a frame.
const OBSERVE = () => {
  const seen = (window.__perf = { cls: 0, lcp: 0, tasks: [], events: [] });
  const watch = (type, each, options) =>
    new PerformanceObserver((list) => list.getEntries().forEach(each)).observe({ type, buffered: true, ...options });
  watch("layout-shift", (entry) => { if (!entry.hadRecentInput) seen.cls += entry.value; });
  watch("largest-contentful-paint", (entry) => { seen.lcp = entry.startTime; });
  watch("longtask", (entry) => seen.tasks.push(entry.duration));
  watch("event", (entry) => { if (entry.interactionId) seen.events.push(entry.duration); }, { durationThreshold: 16 });
};

const PROFILES = {
  phone: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, cpu: 4 },
  laptop: { viewport: { width: 1440, height: 900 }, cpu: 2 },
};

const click = (role, text, options) => (page) => page.getByRole(role, { name: text, ...options }).first().click();
// A speaker chip, found inside its group: a role query over the whole long transcript names thousands of buttons, which
// on CI's throttled phone outlasts the click's timeout. What is measured is the click, not the finding. The group is
// named Talare, by the word above it, where the speakers can be named, and Visa talare where they cannot. Where the filter
// is a list instead (a phone, a large meeting: TranscriptPlayer's speakerList), the speaker is chosen from it; "Alla" is
// the list's "Alla talare".
const chip = (text) => async (page) => {
  const group = page.getByRole("group", { name: /^(Talare|Visa talare)$/ });
  if (await group.count()) return group.getByRole("button", { name: text, exact: true }).click();
  await page.getByRole("combobox", { name: /^(Talare|Filtrera talare)$/ }).click();
  await page.getByRole("option", { name: text === "Alla" ? "Alla talare" : text, exact: true }).click();
};
const type = (text, label) => (page) => page.getByRole("textbox", { name: label }).first().pressSequentially(text, { delay: 60 });
// The page folds its columns into tabs below a laptop's width (1024 px): there the tab must be there and is pressed (a
// tab that is gone fails the step); on a laptop the columns stand side by side and there is nothing to press.
const tab = (text) => async (page) => {
  if (page.viewportSize().width >= 1024) return;
  await page.getByRole("tab", { name: text }).click();
};

const flow = (id, run) => `/flows/${id}${run ? `?run=${run}` : ""}`;
const nameOf = (text) => ({ name: text });
// Page, the address, what shows it has loaded, and the fixed interactions measured on it (label, action).
const PAGES = [
  ["list", "/flows", (page) => page.getByRole("link", { name: /Nämndmöte till rapport/ }).waitFor(), []],
  [
    "setup",
    flow(ids.flows.flow1),
    (page) => page.getByRole("heading", nameOf("Tidigare körningar")).waitFor(),
    [
      ["radio Spela in", click("radio", "Spela in", { exact: true })],
      ["radio Ladda upp", click("radio", "Ladda upp", { exact: true })],
      ["switch Märk upp talare", click("switch", "Märk upp talare", { exact: true })],
    ],
  ],
  [
    "result",
    flow(ids.flows.flow1, ids.runs.done),
    (page) => page.getByRole("heading", { name: /Dokumentet är klart/ }).waitFor(),
    [
      ["tab Transkribering", tab("Transkribering")],
      ["chip Talare 1", chip("Talare 1")],
      ["type search", type("budget", "Sök i transkriberingen")],
      ["Rätta open", click("button", /^Rätta/)],
      ["Rätta Escape", (page) => page.keyboard.press("Escape")],
    ],
  ],
  [
    "review",
    flow(ids.flows.flow2, ids.runs.review),
    (page) => page.getByRole("button", { name: /^Spela från/ }).first().waitFor(),
    [
      ["Namnge talarna open", click("button", "Namnge talarna", { exact: true })],
      ["Namnge talarna Escape", (page) => page.keyboard.press("Escape")],
    ],
  ],
];

// The run of two hours (2,000 passages) the stub keeps for this.
const LONG = flow(ids.flows.flow1, ids.runs.long);
const LONG_ACTIONS = [
  ["tab Transkribering", tab("Transkribering")],
  ["chip Talare 1", chip("Talare 1")],
  ["chip Alla", chip("Alla")],
  ["type search", type("budget", "Sök i transkriberingen")],
  ["clear search", (page) => page.getByRole("textbox", { name: "Sök i transkriberingen" }).fill("")],
  ["Rätta open", click("button", /^Rätta/)],
  ["Rätta Escape", (page) => page.keyboard.press("Escape")],
];

async function signedIn(browser, profile) {
  const { cpu, ...context } = profile;
  const ctx = await browser.newContext({ ...context, locale: "sv-SE" });
  const login = await ctx.newPage();
  await login.goto(`${BASE}/flows`);
  await login.getByRole("button", { name: "Logga in med Eneo" }).click();
  await login.getByRole("link", { name: /Nämndmöte till rapport/ }).waitFor();
  await login.close();
  return ctx;
}

/** A page with the profile's CPU, an empty cache (a first visit) and the observers from its first script. */
async function open(ctx, profile) {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.clearBrowserCache");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
  await page.addInitScript(OBSERVE);
  return page;
}

/** The longest an interaction took from input to paint, 0 for one under a frame; INP of one interaction. */
async function interaction(page, act, label) {
  await page.evaluate(() => (window.__perf.events = []));
  await act(page).catch((error) => {
    error.message = `${label}: ${error.message}`;
    throw error;
  });
  await page.waitForTimeout(600);
  return page.evaluate(() => Math.max(0, ...window.__perf.events));
}

// One round on one profile: the numbers by [group, name, kind, unit].
async function round(browser, profile) {
  const found = [];
  const ctx = await signedIn(browser, profile);
  for (const [group, path, loaded, actions] of PAGES) {
    const page = await open(ctx, profile);
    await page.goto(BASE + path);
    await loaded(page);
    await page.waitForTimeout(1000);
    const load = await page.evaluate(() => ({
      lcp: window.__perf.lcp,
      tbt: window.__perf.tasks.reduce((sum, duration) => sum + Math.max(0, duration - 50), 0),
    }));
    found.push([group, "LCP", "report", "ms", load.lcp], [group, "blocking time", "report", "ms", load.tbt]);
    for (const [label, act] of actions) found.push([group, `INP ${label}`, "inp", "ms", await interaction(page, act, `${group} ${label}`)]);
    found.push([group, "CLS", "cls", "", await page.evaluate(() => window.__perf.cls)]);
    await page.close();
  }

  // From the list to a flow, with the list read for a moment.
  const page = await open(ctx, profile);
  await page.goto(`${BASE}/flows`);
  const link = page.getByRole("link", { name: /Nämndmöte till rapport/ });
  await link.waitFor();
  await page.waitForTimeout(1500);
  const started = Date.now();
  await link.click();
  await page.getByRole("heading", nameOf("Tidigare körningar")).waitFor();
  found.push(["list to flow", "time", "report", "ms", Date.now() - started]);
  await page.close();

  const long = await open(ctx, profile);
  const begun = Date.now();
  await long.goto(BASE + LONG);
  await long.getByRole("heading", { name: /Dokumentet är klart/ }).waitFor();
  await long.getByText("Välkomna till kommunstyrelsens möte.").first().waitFor({ state: "attached", timeout: 60_000 });
  found.push(["long transcript", "ready", "report", "ms", Date.now() - begun]);
  await long.waitForTimeout(1500);
  for (const [label, act] of LONG_ACTIONS) found.push(["long transcript", `INP ${label}`, "inpLong", "ms", await interaction(long, act, `long transcript ${label}`)]);
  await ctx.close();
  return found;
}

mkdirSync(OUT, { recursive: true });
let metrics;
try {
  const stub = serve("python3", ["tests/e2e/stub-server.py", String(STUB)]);
  await ready(stub, `http://127.0.0.1:${STUB}/__stub/stats`);
  const backend = serve(process.execPath, ["tests/prod/start-backend.mjs"], {
    BACKEND_PORT: String(APP),
    STUB_URL: `http://127.0.0.1:${STUB}`,
    STATIC_DIR: join(FRONTEND, "dist"),
  });
  await ready(backend, `${BASE}/health`);

  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  const samples = new Map();
  try {
    for (let n = 1; n <= runs; n++) {
      console.log(`Run ${n} of ${runs}`);
      for (const [profile, settings] of Object.entries(PROFILES)) {
        const found = await round(browser, settings).catch((error) => {
          error.message = `${profile}, run ${n}: ${error.message}`;
          throw error;
        });
        for (const [group, metric, kind, unit, value] of found) {
          const key = `${profile}\t${group}\t${metric}`;
          samples.set(key, { profile, group, name: metric, kind, unit, values: [...(samples.get(key)?.values ?? []), value] });
        }
      }
    }
  } finally {
    await browser.close();
  }
  metrics = [...samples.values()].map((sample) => ({ ...sample, median: median(sample.values) }));
} finally {
  await stopServers();
}

writeFileSync(join(OUT, `${label}.json`), JSON.stringify({ label, runs, date: new Date().toISOString(), metrics }, null, 2));

const over = metrics.filter((metric) => metric.median > (budget[metric.kind]?.[metric.profile] ?? Infinity));
const profiles = Object.keys(PROFILES);
table(
  ["metric", ...profiles.flatMap((profile) => [profile, `${profile} budget`])],
  rowsOf(metrics).map(([key, { metric, values }]) => [
    key,
    ...profiles.flatMap((profile) => {
      const limit = budget[metric.kind]?.[profile];
      const flagged = over.some((bad) => bad.profile === profile && `${bad.group} ${bad.name}` === key);
      return [format(metric, values[profile]) + (flagged ? " !" : ""), limit === undefined ? "" : format(metric, limit)];
    }),
  ]),
);
console.log(`\n${label}: ${join("test-results", "perf", `${label}.json`)}`);
if (over.length) {
  console.error(`\n${over.length} over budget: ${over.map((metric) => `${metric.profile} ${metric.group} ${metric.name} ${format(metric, metric.median)}`).join("; ")}`);
  process.exit(2);
}
