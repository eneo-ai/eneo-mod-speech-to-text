import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NameCombobox } from "../components/NameCombobox";

// WCAG relative luminance using the actual CSS tokens, including alpha backgrounds.
type RGB = [number, number, number];
function hsl(h: number, s: number, l: number): RGB {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [channel(0), channel(8), channel(4)];
}
function contrast(a: RGB, b: RGB) {
  const luminance = (rgb: RGB) => rgb.map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const [high, low] = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (high + .05) / (low + .05);
}
const css = readFileSync("app/globals.css", "utf8");
const declarations = (selector: string): Record<string, string> => Object.fromEntries([...css.split(`${selector} {`)[1].split("}")[0]
  .matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
// .dark sits on the same element as :root, so a token declared once as var(--x) follows the theme.
const themes = { ":root": declarations(":root"), ".dark": { ...declarations(":root"), ...declarations(".dark") } };

for (const [theme, raw] of Object.entries(themes)) {
  const color = (name: string): RGB => {
    const value = raw[name];
    assert.ok(value, `${theme} defines --${name}`);
    const reference = /^var\(--([\w-]+)\)$/.exec(value);
    if (reference) return color(reference[1]);
    const parts = /^(\d+) (\d+)% (\d+)%$/.exec(value);
    assert.ok(parts, `--${name} is an HSL triplet: ${value}`);
    return hsl(Number(parts[1]), Number(parts[2]), Number(parts[3]));
  };
  const atLeast = (minimum: number, foreground: string, background: string) => {
    const ratio = contrast(color(foreground), color(background));
    assert.ok(ratio >= minimum, `${theme} ${foreground} on ${background}: ${ratio.toFixed(2)} < ${minimum}`);
  };

  test(`${theme} editor text, speaker labels, focus and control edges meet AA contrast`, () => {
    for (const foreground of ["ink", "ink-soft", "ink-mute", "primary", "ochre", ...Array.from({ length: 6 }, (_, i) => `speaker-${i}`)]) {
      for (const background of ["paper", "bg", "bg-2"]) atLeast(4.5, foreground, background);
    }
    for (const background of ["paper", "bg-2"]) atLeast(3, "rule", background);
    atLeast(4.5, "primary-foreground", "primary");
    for (const alpha of [.1, .2, .25, .3]) {
      const blended = color("paper").map((v, i) => v * (1 - alpha) + color("primary")[i] * alpha) as RGB;
      assert.ok(contrast(color("ink"), blended) >= 4.5, `selected text on primary/${alpha}`);
      if (alpha <= .2) assert.ok(contrast(color("primary"), blended) >= 4.5, `confirm button on primary/${alpha}`);
    }
  });

  test(`${theme} defines the shadcn semantic tokens with readable pairs`, () => {
    for (const [foreground, background] of [
      ["foreground", "background"], ["card-foreground", "card"], ["popover-foreground", "popover"],
      ["primary-foreground", "primary"], ["secondary-foreground", "secondary"], ["accent-foreground", "accent"],
      ["destructive-foreground", "destructive"],
    ]) atLeast(4.5, foreground, background);
    // Muted text also carries disabled controls, which keep their words readable.
    for (const foreground of ["foreground", "muted-foreground", "primary", "destructive"]) {
      for (const background of ["background", "card", "muted"]) atLeast(4.5, foreground, background);
    }
    // Control edges and the focus ring are UI parts: 3:1 against every surface they sit on.
    for (const background of ["background", "card", "muted"]) atLeast(3, "input", background);
    for (const background of ["background", "card"]) atLeast(3, "ring", background);
    color("border");
  });

  test(`${theme} status colours: the recording dot, errors and the selected tint`, () => {
    // The recording dot is a UI part next to its word; it shows on every surface.
    for (const background of ["background", "card", "muted"]) atLeast(3, "record", background);
    // An error or a destructive action never looks like "recording".
    const apart = contrast(color("destructive"), color("record"));
    assert.ok(apart >= 1.4, `${theme} destructive and record are distinct: ${apart.toFixed(2)}`);
    // A selected card: its text, its secondary line and its border on the tint.
    atLeast(4.5, "foreground", "primary-soft");
    atLeast(4.5, "ink-soft", "primary-soft");
    atLeast(3, "primary", "primary-soft");
  });
}

test("speaker names with spaces and punctuation produce valid unique option IDs", () => {
  const html = renderToStaticMarkup(createElement(NameCombobox, {
    value: null, options: ["Anna Andersson", "Bo / Carl", "none", "add"], onChange: () => {}, "aria-label": "Namn för Talare 1",
  }));
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => !/\s/.test(id)));
  assert.match(html, /role="listbox" aria-label="Förslag: Namn för Talare 1"/);
});
