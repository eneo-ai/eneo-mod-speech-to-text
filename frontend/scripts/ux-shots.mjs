// The screenshot sweep and its comparison, for review by eye: every gate state at every size of the device matrix
// (tests/shots/shots.spec.ts), in light and dark.
//
//   npm run ux:shots                         a run, labelled with the short commit (and -dirty for changed files)
//   npm run ux:shots -- --name mode-cards    the label gets a name: <sha>-mode-cards
//   npm run ux:shots -- --label before       the label exactly
//   npm run ux:shots -- --sizes 1000x800,390x844 -g setup    some sizes, some states (the rest goes to Playwright)
//   npm run ux:shots -- --compare <before> <after>           one report: before, after and the pixels that changed
//
// A run writes ux-shots/<label>/<state>/<width>x<height>-<mode>.png (and .first.png, the first screen of a taller
// page) and a contact sheet, ux-shots/<label>/index.html. A comparison writes ux-shots/compare/<before>__<after>/index.html.
// ux-shots/ is ignored by git; the pictures are never committed.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "ux-shots");
const args = process.argv.slice(2);

/** Takes `--flag value` out of the arguments; what is left goes to Playwright. */
function option(flag, count = 1) {
  const at = args.indexOf(flag);
  if (at < 0) return null;
  const values = args.splice(at, count + 1).slice(1);
  if (values.length !== count || values.some((value) => value.startsWith("--"))) fail(`${flag} takes ${count} value(s).`);
  return count === 1 ? values[0] : values;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const STYLE = `<style>
:root { color-scheme: light dark; font: 14px/1.4 system-ui, sans-serif; }
body { margin: 0 16px 48px; }
header { position: sticky; top: 0; padding: 12px 0; background: Canvas; border-bottom: 1px solid GrayText; z-index: 1; }
h1 { font-size: 18px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 32px 0 8px; }
.grid { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; }
figure { margin: 0; } figcaption { font-size: 12px; margin-top: 4px; }
.thumb img { width: 180px; height: auto; border: 1px solid GrayText; }
.pair { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 12px 0 24px; }
.pair img { width: 100%; height: auto; border: 1px solid GrayText; }
.pair > p { grid-column: 1 / -1; margin: 0; font-weight: 600; }
.changed > p::before { content: "Changed "; color: #c4002f; }
body:has(#only:checked) .pair:not(.changed) { display: none; }
body:has(#only:checked) section:not(:has(.changed)) { display: none; }
ol { columns: 3; font-size: 12px; } a { color: LinkText; }
</style>`;

/** The pictures of a run, by state: [state, [file, …]]. */
function pictures(label) {
  const dir = join(ROOT, label);
  if (!existsSync(dir)) fail(`No run labelled ${label} in ${ROOT}.`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => [entry.name, readdirSync(join(dir, entry.name)).filter((file) => file.endsWith(".png")).sort(order)])
    .sort(([a], [b]) => a.localeCompare(b));
}

// By width, then height, then mode, then the full page before its first screen.
function order(a, b) {
  const key = (file) => file.match(/^(\d+)x(\d+)-(\w+)(\.first)?\.png$/)?.slice(1) ?? [0, 0, file, ""];
  const [x, y] = [key(a), key(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]) || (x[3] ?? "").localeCompare(y[3] ?? "");
}

function contactSheet(label) {
  const states = pictures(label);
  const body = states
    .map(
      ([state, files]) =>
        `<section><h2 id="${escape(state)}">${escape(state)}</h2><div class="grid">${files
          .map(
            (file) =>
              `<figure class="thumb"><a href="${escape(`${state}/${file}`)}"><img loading="lazy" src="${escape(`${state}/${file}`)}" alt=""></a><figcaption>${escape(file.replace(/\.png$/, ""))}</figcaption></figure>`,
          )
          .join("")}</div></section>`,
    )
    .join("\n");
  const count = states.reduce((sum, [, files]) => sum + files.length, 0);
  const page = `<!doctype html><meta charset="utf-8"><title>ux-shots ${escape(label)}</title>${STYLE}
<header><h1>${escape(label)}</h1>${states.length} states, ${count} pictures. ${states.map(([state]) => `<a href="#${escape(state)}">${escape(state)}</a>`).join(" · ")}</header>
${body}`;
  writeFileSync(join(ROOT, label, "index.html"), page);
  return join(ROOT, label, "index.html");
}

async function compare(before, after) {
  const { chromium } = await import("@playwright/test");
  const out = join(ROOT, "compare", `${before}__${after}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "diff"), { recursive: true });
  const a = new Map(pictures(before));
  const b = new Map(pictures(after));
  const states = [...new Set([...a.keys(), ...b.keys()])].sort();

  // The browser decodes and compares the pictures; they are served from one made-up origin so its canvas may read them.
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.route("http://ux-shots.test/**", (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname).slice(1);
    return path ? route.fulfill({ path: join(ROOT, path), contentType: "image/png" }) : route.fulfill({ body: "<!doctype html>", contentType: "text/html" });
  });
  await page.goto("http://ux-shots.test/");

  const rows = [];
  for (const state of states) {
    const files = [...new Set([...(a.get(state) ?? []), ...(b.get(state) ?? [])])].sort(order);
    for (const file of files) {
      const left = join(ROOT, before, state, file);
      const right = join(ROOT, after, state, file);
      const row = { state, file, left: existsSync(left), right: existsSync(right), changed: 0, share: 0, diff: null };
      if (!row.left || !row.right) row.share = 1;
      else if (!readFileSync(left).equals(readFileSync(right))) {
        const result = await page.evaluate(diff, [`/${before}/${state}/${file}`, `/${after}/${state}/${file}`].map(encodeURI));
        row.changed = result.changed;
        row.share = result.changed / result.total;
        if (result.png) {
          row.diff = `diff/${state}--${file}`;
          writeFileSync(join(out, row.diff), Buffer.from(result.png, "base64"));
        }
      }
      rows.push(row);
    }
  }
  await browser.close();

  const id = (row) => `${row.state}--${row.file}`;
  const changed = rows.filter((row) => row.share > 0).sort((x, y) => y.share - x.share);
  const percent = (row) => (!row.left ? "new" : !row.right ? "gone" : `${(row.share * 100).toFixed(row.share < 0.001 ? 3 : 2)} %`);
  const image = (label, row, side) =>
    row[side] ? `<a href="${escape(relative(out, join(ROOT, label, row.state, row.file)))}"><img loading="lazy" alt="" src="${escape(relative(out, join(ROOT, label, row.state, row.file)))}"></a>` : "<span>none</span>";
  const body = states
    .map((state) => {
      const pairs = rows
        .filter((row) => row.state === state)
        .map(
          (row) => `<div class="pair${row.share > 0 ? " changed" : ""}" id="${escape(id(row))}"><p>${escape(row.file.replace(/\.png$/, ""))} · ${row.share > 0 ? percent(row) : "same"}</p>
${image(before, row, "left")}${image(after, row, "right")}${row.diff ? `<a href="${escape(row.diff)}"><img loading="lazy" alt="" src="${escape(row.diff)}"></a>` : "<span></span>"}</div>`,
        )
        .join("\n");
      return `<section><h2>${escape(state)}</h2>${pairs}</section>`;
    })
    .join("\n");
  const html = `<!doctype html><meta charset="utf-8"><title>ux-shots ${escape(before)} → ${escape(after)}</title>${STYLE}
<header><h1>${escape(before)} → ${escape(after)}</h1>
<label><input type="checkbox" id="only" checked> Only the ${changed.length} changed of ${rows.length} pictures</label>
· Columns: before, after, and the after picture faded with the changed pixels in red.</header>
<h2>Changed, most first</h2><ol>${changed.map((row) => `<li><a href="#${escape(id(row))}">${escape(row.state)} ${escape(row.file.replace(/\.png$/, ""))}</a> ${percent(row)}</li>`).join("")}</ol>
${body}`;
  writeFileSync(join(out, "index.html"), html);
  return { report: join(out, "index.html"), changed: changed.length, total: rows.length };
}

/** In the page: the share of pixels that differ, and a picture of where, the after picture faded under red marks. */
async function diff([beforeUrl, afterUrl]) {
  const load = (src) => new Promise((done, failed) => Object.assign(new Image(), { onload() { done(this); }, onerror: failed, src }));
  const [x, y] = await Promise.all([load(beforeUrl), load(afterUrl)]);
  const width = Math.max(x.width, y.width);
  const height = Math.max(x.height, y.height);
  const read = (image) => {
    const context = new OffscreenCanvas(width, height).getContext("2d");
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, width, height).data;
  };
  const [p, q] = [read(x), read(y)];
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  const picture = context.createImageData(width, height);
  const d = picture.data;
  let changed = 0;
  for (let i = 0; i < p.length; i += 4) {
    // Past the end of the shorter picture one of the two is transparent, which counts as changed.
    const delta = Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) + Math.abs(p[i + 3] - q[i + 3]);
    if (delta > 24) {
      changed += 1;
      d.set([228, 0, 52, 255], i);
    } else {
      const light = 255 - (255 - (q[i] * 0.3 + q[i + 1] * 0.59 + q[i + 2] * 0.11)) * 0.25;
      d.set([light, light, light, 255], i);
    }
  }
  if (changed === 0) return { changed, total: width * height };
  context.putImageData(picture, 0, 0);
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { changed, total: width * height, png: btoa(text) };
}

const pair = option("--compare", 2);
if (pair) {
  const { report, changed, total } = await compare(...pair);
  console.log(`${changed} of ${total} pictures changed: ${report}`);
  process.exit(0);
}

const indexLabel = option("--index");
if (indexLabel) {
  console.log(`Contact sheet: ${contactSheet(indexLabel)}`);
  process.exit(0);
}

const git = (...command) => execFileSync("git", command, { encoding: "utf8" }).trim();
const name = option("--name");
const sizes = option("--sizes");
const dirty = git("status", "--porcelain", "--untracked-files=no") !== "";
const label = option("--label") ?? [git("rev-parse", "--short", "HEAD") + (dirty ? "-dirty" : ""), name].filter(Boolean).join("-");
if (!/^[\w.-]+$/.test(label)) fail(`A label is letters, digits, dots and dashes: ${label}`);
const dir = join(ROOT, label);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const run = spawnSync("npx", ["playwright", "test", "--config", "playwright.shots.config.ts", ...args], {
  stdio: "inherit",
  env: { ...process.env, UX_SHOTS_DIR: dir, ...(sizes ? { SHOTS_SIZES: sizes } : {}) },
});
console.log(`Contact sheet: ${contactSheet(label)}`);
process.exit(run.status ?? 1);
