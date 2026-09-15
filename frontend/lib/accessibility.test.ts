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
for (const theme of [":root", ".dark"]) {
  const block = css.split(`${theme} {`)[1].split("}")[0];
  const colors = Object.fromEntries([...block.matchAll(/--([\w-]+): (\d+) (\d+)% (\d+)%\s*;/g)]
    .map((m) => [m[1], hsl(Number(m[2]), Number(m[3]), Number(m[4]))]));
  test(`${theme} editor text, speaker labels, focus and control edges meet AA contrast`, () => {
    for (const foreground of ["ink", "ink-soft", "ink-mute", "accent", "ochre", ...Array.from({ length: 6 }, (_, i) => `speaker-${i}`)]) {
      for (const background of ["paper", "bg", "bg-2"]) assert.ok(contrast(colors[foreground], colors[background]) >= 4.5, `${foreground} on ${background}: ${contrast(colors[foreground], colors[background])}`);
    }
    for (const background of ["paper", "bg-2"]) assert.ok(contrast(colors.rule, colors[background]) >= 3);
    assert.ok(contrast(colors["accent-foreground"], colors.accent) >= 4.5);
    for (const alpha of [.1, .2, .25, .3]) {
      const blended = colors.paper.map((v, i) => v * (1 - alpha) + colors.accent[i] * alpha) as RGB;
      assert.ok(contrast(colors.ink, blended) >= 4.5, `selected text on accent/${alpha}`);
      if (alpha <= .2) assert.ok(contrast(colors.accent, blended) >= 4.5, `confirm button on accent/${alpha}`);
    }
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
