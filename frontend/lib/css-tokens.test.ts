import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The module's stylesheets (every CSS Module and styles/globals.css) take spacing, radius, colour, font size and border
// width from the design system's tokens: var(--spacing-*), var(--radius-*), var(--color-*) (and the module's own
// --module-* colours), var(--font-size-*), var(--border-width). A raw px, rem or em length or a raw colour (hex, rgb(),
// hsl(), ...) in one of those properties is a value the theme cannot change, and a spacing or size nobody chose from the
// scale. What stays raw is written down below, each with its reason, or is waiting to be replaced.
//
// Not checked: a custom property's own definition (a raw value is named once there, as --module-speaker-0 is), the
// lengths of width, height, position and shadows (structure, not the scale), and the generated theme.

const root = join(__dirname, "..", "..");

const SPACING = /^(margin|padding|gap|row-gap|column-gap|scroll-margin|scroll-padding)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/;
const RADIUS = /^border(-(top|bottom|start|end)-(left|right|start|end))?-radius$/;
const FONT_SIZE = /^font-size$/;
const COLOUR = /^(color|background|background-color|background-image|border-color|border-(top|right|bottom|left|block|inline)(-(start|end))?-color|outline-color|fill|stroke|caret-color|accent-color|text-decoration-color|box-shadow|text-shadow|border|border-(top|right|bottom|left|block|inline)(-(start|end))?|outline|text-decoration|column-rule)$/;
const BORDER_WIDTH = /^(border-width|border-(top|right|bottom|left|block|inline)(-(start|end))?-width|outline-width|border|border-(top|right|bottom|left|block|inline)(-(start|end))?|outline)$/;

const LENGTH = /(?<![\w.#-])-?\d*\.?\d+(px|rem|em|pt)\b/;
const HAIRLINE = /(?<![\w.#-])-?\d*\.?\d+(px|rem|em|pt)\b/g;
const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/;
// A zero needs no unit, and no token: it is the absence of the thing.
const withoutZeros = (value: string) => value.replace(/(?<![\w.#-])0(\.0+)?(px|rem|em|pt)\b/g, "0");

/**
 * A 1px border or outline is the design system's own --border-width (asserted below against its stylesheet), so a
 * hairline written as 1px is the token's value, not another choice.
 */
const isHairline = (value: string) => [...value.matchAll(HAIRLINE)].every((match) => match[0] === "1px");

interface Declaration {
  context: string;
  property: string;
  value: string;
}

/** The declarations of a stylesheet, each with the at-rules and the selector it sits in. */
function declarations(css: string): Declaration[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Declaration[] = [];
  const context: string[] = [];
  let buffer = "";
  let parens = 0;
  let quote: string | null = null;
  const declaration = () => {
    const at = buffer.indexOf(":");
    if (at > 0 && !buffer.trim().startsWith("@")) {
      out.push({ context: context.join(" > "), property: buffer.slice(0, at).trim(), value: buffer.slice(at + 1).trim().replace(/\s+/g, " ") });
    }
    buffer = "";
  };
  for (const char of text) {
    if (quote) {
      buffer += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      buffer += char;
    } else if (char === "(") {
      parens += 1;
      buffer += char;
    } else if (char === ")") {
      parens -= 1;
      buffer += char;
    } else if (char === "{" && parens === 0) {
      context.push(buffer.trim().replace(/\s+/g, " "));
      buffer = "";
    } else if (char === "}" && parens === 0) {
      if (buffer.trim()) declaration();
      buffer = "";
      context.pop();
    } else if (char === ";" && parens === 0) {
      declaration();
    } else {
      buffer += char;
    }
  }
  return out;
}

/** What is raw in a stylesheet's scale properties, one line each: `<file> | <context> | <property>: <value>`. */
function rawValues(css: string, file: string): string[] {
  const found: string[] = [];
  for (const { context, property, value } of declarations(css)) {
    if (property.startsWith("--")) continue;
    const bare = withoutZeros(value);
    const raw =
      (SPACING.test(property) && LENGTH.test(bare)) ||
      (RADIUS.test(property) && LENGTH.test(bare)) ||
      (FONT_SIZE.test(property) && LENGTH.test(bare)) ||
      (COLOUR.test(property) && COLOUR_LITERAL.test(bare)) ||
      (BORDER_WIDTH.test(property) && LENGTH.test(bare) && !isHairline(bare));
    if (raw) found.push(`${file} | ${context} | ${property}: ${value}`);
  }
  return found;
}

/** Raw values that are right, and why. */
const ALLOWED: Record<string, string> = {
  "components/NameCombobox.module.css | @media (forced-colors: active) > .option[aria-selected=\"true\"] | outline: 2px solid Highlight":
    "forced colours: the system's Highlight is the only colour there, and 2px is the thickness of the selection's indicator",
  "components/TranscriptEditor.module.css | @media (forced-colors: active) > .word[aria-current=\"true\"] | outline: 2px solid Highlight":
    "forced colours: the system's Highlight is the only colour there, and 2px is the thickness of the indicator",
  "components/TranscriptEditor.module.css | @media (forced-colors: active) > .word[data-selected] | outline: 2px solid Highlight":
    "forced colours: the system's Highlight is the only colour there, and 2px is the thickness of the indicator",
  "components/TranscriptEditor.module.css | @media (forced-colors: active) > .text:focus-visible [data-caret-paragraph=\"true\"] | border-inline-start: 3px solid Highlight":
    "forced colours: the system's Highlight is the only colour there, and 3px is the caret's bar",
  "components/TranscriptPlayer.module.css | @media (forced-colors: active) > .turn[data-active=\"true\"] | outline: 2px solid Highlight":
    "forced colours: the system's Highlight is the only colour there, and 2px is the thickness of the indicator",
  "styles/globals.css | @media (forced-colors: active) > .astryx-slider-thumb | border: 2px solid Canvas":
    "forced colours: the system's Canvas is the only colour there, and 2px keeps the thumb apart from the track",
};

/** Raw values to be replaced by a token, and with which: the design lane empties this list, and an entry that no longer occurs fails the test. */
const TO_REPLACE: Record<string, string> = {};

function stylesheets(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "built" ? [] : stylesheets(path);
    return entry.name.endsWith(".module.css") ? [path] : [];
  });
}

const files = [...["components", "routes", "kit"].flatMap(stylesheets), "styles/globals.css"];

test("the stylesheets take spacing, radius, colour, font size and border width from tokens", () => {
  const found = files.flatMap((file) => rawValues(readFileSync(join(root, file), "utf8"), file));
  const unknown = found.filter((line) => !(line in ALLOWED) && !(line in TO_REPLACE));
  assert.deepEqual(
    unknown,
    [],
    "a raw px, rem or em length, or a raw colour: use var(--spacing-*), var(--radius-*), var(--color-*), var(--font-size-*) or var(--border-width), or write the exception in ALLOWED with its reason",
  );
});

test("what is allowed raw, or waits to be replaced, is still there: an entry that no longer occurs is removed", () => {
  const found = new Set(files.flatMap((file) => rawValues(readFileSync(join(root, file), "utf8"), file)));
  assert.deepEqual(
    [...Object.keys(ALLOWED), ...Object.keys(TO_REPLACE)].filter((line) => !found.has(line)),
    [],
    "listed, but not in any stylesheet any more: delete the entry",
  );
});

test("a hairline written as 1px is the design system's border width", () => {
  const sheet = readFileSync(join(root, "node_modules", "@astryxdesign", "core", "dist", "astryx.css"), "utf8");
  assert.match(sheet, /--border-width:\s*1px\b/);
});

test("the scan finds a raw length or colour in a scale property, and nothing else", () => {
  const css = `
    .a { padding: 12px var(--spacing-2); margin-block: 0.5rem; gap: var(--spacing-3); }
    .b { border-radius: 4px; font-size: 1.1em; color: #123456; background: rgb(0 0 0 / 50%); }
    .c { border: 1px solid var(--color-border-subtle); outline: 2px solid var(--color-focus); border-width: 3px; }
    @media (max-width: 600px) { .d { padding: 0 var(--spacing-4); margin: -1px; scroll-margin-block: var(--bar, 0px) 1rem; } }
    .e { padding: var(--spacing-3); border-radius: var(--radius-inner); color: var(--color-text-primary); width: 640px; --x: 12px; --c: #fff; }
    .f { background: url("data:image/svg+xml;utf8,<svg fill='%23fff'/>") no-repeat; box-shadow: 0 0 0 2px var(--color-accent); }
  `;
  assert.deepEqual(rawValues(css, "t.css"), [
    "t.css | .a | padding: 12px var(--spacing-2)",
    "t.css | .a | margin-block: 0.5rem",
    "t.css | .b | border-radius: 4px",
    "t.css | .b | font-size: 1.1em",
    "t.css | .b | color: #123456",
    "t.css | .b | background: rgb(0 0 0 / 50%)",
    "t.css | .c | outline: 2px solid var(--color-focus)",
    "t.css | .c | border-width: 3px",
    "t.css | @media (max-width: 600px) > .d | margin: -1px",
    "t.css | @media (max-width: 600px) > .d | scroll-margin-block: var(--bar, 0px) 1rem",
  ]);
});
