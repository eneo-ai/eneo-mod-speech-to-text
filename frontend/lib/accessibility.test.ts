import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolveThemeTokens, type ResolvedThemeMode } from "@astryxdesign/core/theme/tokens";

// WCAG relative luminance of the values the browser paints: the built theme's resolved tokens and the module's own
// `--module-*` colours in globals.css. Alpha fills are composited over the surface they sit on.
type RGBA = [number, number, number, number];

function hslToRgb(h: number, s: number, l: number): RGBA {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [channel(0), channel(8), channel(4), 1];
}
function parseColor(value: string): RGBA {
  const text = value.trim();
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(text);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16) / 255).concat(hex[2] ? parseInt(hex[2], 16) / 255 : 1) as RGBA;
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/.exec(text);
  if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255, rgb[4] === undefined ? 1 : Number(rgb[4])];
  const hsl = /^hsl\(\s*([\d.]+)(?:deg)?[,\s]+([\d.]+)%[,\s]+([\d.]+)%\s*\)$/.exec(text);
  if (hsl) return hslToRgb(Number(hsl[1]), Number(hsl[2]), Number(hsl[3]));
  assert.fail(`not a colour this test reads: ${value}`);
}
const over = (foreground: RGBA, background: RGBA): RGBA => {
  const alpha = foreground[3];
  return [0, 1, 2].map((i) => foreground[i] * alpha + background[i] * (1 - alpha)).concat(1) as RGBA;
};
function contrast(a: RGBA, b: RGBA) {
  const luminance = (rgb: RGBA) => rgb.slice(0, 3).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const [high, low] = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (high + .05) / (low + .05);
}
function hue([r, g, b]: RGBA) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

const css = readFileSync("styles/globals.css", "utf8");
// A colour the module defines once for both modes: `--name: light-dark(<light>, <dark>)`.
function pair(name: string): [string, string] {
  const match = new RegExp(`--${name}:\\s*light-dark\\(\\s*(hsl\\([^)]*\\)|#[0-9a-f]+)\\s*,\\s*(hsl\\([^)]*\\)|#[0-9a-f]+)\\s*\\)`, "i").exec(css);
  assert.ok(match, `globals.css defines --${name} as light-dark(<light>, <dark>)`);
  return [match[1], match[2]];
}
// The recording colour is `--module-color-record`.
const recordPair = (): [string, string] => pair("module-color-record");

const SPEAKERS = Array.from({ length: 6 }, (_, i) => `module-speaker-${i}`);

async function themeTokens(mode: ResolvedThemeMode) {
  const { eneoTheme } = await import("@/kit/theme/built/eneo");
  return resolveThemeTokens(eneoTheme, { mode });
}

for (const [index, mode] of (["light", "dark"] as const).entries()) {
  // The three grounds text and controls sit on: the card, the page, and a muted fill (an alpha) over the card.
  async function palette() {
    const tokens = await themeTokens(mode);
    const token = (name: string) => parseColor(tokens[name]);
    const surface = token("--color-background-surface");
    const grounds = { surface, body: token("--color-background-body"), muted: over(token("--color-background-muted"), surface) };
    const module = (name: string) => parseColor(pair(name)[index]);
    const atLeast = (minimum: number, foreground: RGBA, background: RGBA, what: string) => {
      const ratio = contrast(foreground, background);
      assert.ok(ratio >= minimum, `${mode} ${what}: ${ratio.toFixed(2)} < ${minimum}`);
    };
    return { token, module, surface, grounds, atLeast };
  }

  test(`${mode}: text, error text, speaker labels, review marks, focus and control edges meet AA contrast`, async () => {
    const { token, module, surface, grounds, atLeast } = await palette();
    const foregrounds: [string, RGBA][] = [
      ["text-primary", token("--color-text-primary")], ["text-secondary", token("--color-text-secondary")], ["accent", token("--color-text-accent")],
      ["error", token("--color-error")],
      ["review", module("module-color-review")], ...SPEAKERS.map((name): [string, RGBA] => [name, module(name)]),
    ];
    for (const [name, foreground] of foregrounds) {
      for (const [ground, background] of Object.entries(grounds)) atLeast(4.5, foreground, background, `${name} on ${ground}`);
    }
    // Confirmed words are text of the transcript, which sits on its card.
    atLeast(4.5, module("module-color-ok"), surface, "ok on surface");
    // A control's edge and the focus ring are UI parts: 3:1 against every ground they sit on.
    for (const [ground, background] of Object.entries(grounds)) atLeast(3, token("--color-border-emphasized"), background, `control edge on ${ground}`);
    for (const ground of ["surface", "body"] as const) atLeast(3, token("--focus-outline-color"), grounds[ground], `focus ring on ${ground}`);
    atLeast(4.5, token("--color-on-accent"), token("--color-accent"), "on-accent on accent");
    atLeast(4.5, token("--color-on-error"), token("--color-error"), "on-error on error");
    // Text over the selection tint.
    for (const alpha of [.1, .2, .25, .3]) {
      const tint = over([...token("--color-accent").slice(0, 3), alpha] as RGBA, surface);
      atLeast(4.5, token("--color-text-primary"), tint, `selected text on accent/${alpha}`);
      if (alpha <= .2) atLeast(4.5, token("--color-text-accent"), tint, `confirm button on accent/${alpha}`);
    }
  });

  test(`${mode}: the confirm mark's glyph is legible on the review colour that fills it on hover`, async () => {
    const { token, module, atLeast } = await palette();
    const hover = /\.confirmButton:hover \.confirmMark \{([^}]*)\}/.exec(readFileSync("components/TranscriptPlayer.module.css", "utf8"))?.[1] ?? "";
    assert.match(hover, /background:\s*var\(--module-color-review\)/, "the mark fills with the review colour on hover");
    const glyph = /(?:^|[\s;])color:\s*var\((--color-[a-z-]+)\)/.exec(hover)?.[1];
    assert.ok(glyph, "and names a theme colour for its glyph");
    atLeast(4.5, token(glyph), module("module-color-review"), `${glyph} on the review colour`);
  });

  test(`${mode}: the first speaker is not the brand's blue, so a name never reads as a link`, async () => {
    const { token, module } = await palette();
    const apart = Math.abs(hue(module("module-speaker-0")) - hue(token("--color-accent")));
    assert.ok(Math.min(apart, 360 - apart) >= 40, `${mode} module-speaker-0 and accent hues: ${apart.toFixed(0)}`);
  });

  test(`${mode}: status colours: the recording dot, errors and the selected tint`, async () => {
    const { token, grounds, surface, atLeast } = await palette();
    const record = parseColor(recordPair()[index]);
    // The recording dot is a UI part next to its word; it shows on every ground.
    for (const [ground, background] of Object.entries(grounds)) atLeast(3, record, background, `record dot on ${ground}`);
    // An error or a destructive action never looks like "recording".
    atLeast(1.4, token("--color-error"), record, "error and record are distinct");
    // A selected card: its text, its secondary line and its accent on the tint.
    const selected = over(token("--color-accent-muted"), surface);
    atLeast(4.5, token("--color-text-primary"), selected, "text on the selected tint");
    atLeast(4.5, token("--color-text-secondary"), selected, "secondary text on the selected tint");
    atLeast(3, token("--color-accent"), selected, "accent on the selected tint");
  });
}

test("controls keep a mouse's density and grow to 44 px targets on a touch screen", async () => {
  const built = readFileSync("kit/theme/built/eneo.css", "utf8");
  const coarse = /@media \(pointer: coarse\) \{[\s\S]*?:scope \{([^}]*)\}/.exec(built)?.[1] ?? "";
  const touch = (size: string) => Number(new RegExp(`--size-element-${size}:\\s*(\\d+)px`).exec(coarse)?.[1]);
  const mouse = await themeTokens("light");
  const onMouse = (size: string) => parseInt(mouse[`--size-element-${size}`], 10);
  for (const size of ["sm", "md"]) assert.ok(onMouse(size) >= 24 && onMouse(size) <= 40, `${size} on a mouse: ${onMouse(size)}`);
  // The large control is the one action a screen exists for: never smaller than the medium one, 48 px at most.
  assert.ok(onMouse("lg") >= onMouse("md") && onMouse("lg") <= 48, `lg on a mouse: ${onMouse("lg")}`);
  assert.equal(touch("sm"), 44, "sm on a touch screen");
  assert.equal(touch("md"), 44, "md on a touch screen");
  assert.ok(touch("lg") >= 44, "lg on a touch screen");
});

// Every size in the design system's tokens is in rem, so the page's text follows the size the reader has set in the browser
// as long as nothing fixes the root's: a px font size on html or body would make a reader's setting do nothing.
test("no stylesheet of the module fixes a font size in pixels", () => {
  const sheets = ["styles", "components", "routes", "kit"].flatMap((folder) =>
    readdirSync(folder, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".css") && !file.includes("built"))
      .map((file) => `${folder}/${file}`),
  );
  assert.ok(sheets.includes("styles/globals.css") && sheets.length > 10, "the module's stylesheets were found");
  const fixed = sheets.flatMap((sheet) => readFileSync(sheet, "utf8").split("\n").flatMap((line, index) => (/font-size:\s*[\d.]+px/.test(line) ? [`${sheet}:${index + 1}`] : [])));
  assert.deepEqual(fixed, []);
});

// Forced colours (Windows' high contrast) drop every tint and shadow: a state that a tint alone shows (the word being
// played, the marked word, the turn and the sentence being read aloud) would not show. Each is outlined there.
test("the states shown by a tint alone are outlined in forced colours", () => {
  const forcedColours = (css: string) => {
    const blocks: string[] = [];
    for (let at = css.indexOf("@media (forced-colors: active)"); at >= 0; at = css.indexOf("@media (forced-colors: active)", at + 1)) {
      let depth = 0;
      for (let i = css.indexOf("{", at); i < css.length; i += 1) {
        depth += css[i] === "{" ? 1 : css[i] === "}" ? -1 : 0;
        if (depth === 0) {
          blocks.push(css.slice(css.indexOf("{", at) + 1, i));
          break;
        }
      }
    }
    return blocks.join("\n");
  };
  const markers: [string, string[]][] = [
    ["components/TranscriptEditor.module.css", [".word[data-active]", ".word[data-selected]"]],
    ["components/TranscriptPlayer.module.css", ['.turn[data-active="true"]', ".sentenceActive"]],
  ];
  const unoutlined = markers.flatMap(([file, selectors]) => {
    const forced = forcedColours(readFileSync(file, "utf8"));
    return selectors.filter((selector) => !new RegExp(`${selector.replace(/[.[\]"=()]/g, "\\$&")}[^{}]*\\{[^}]*outline:`).test(forced)).map((selector) => `${file} ${selector}`);
  });
  assert.deepEqual(unoutlined, []);
});

// 100vh is the window with a phone's address bar drawn away: a page that is at least that tall always scrolls a little.
test("the page's full-height rules measure the visible window, as the rest of the module does", () => {
  assert.deepEqual(
    readFileSync("styles/globals.css", "utf8").split("\n").filter((line) => /\b100vh\b/.test(line)),
    [],
  );
});
