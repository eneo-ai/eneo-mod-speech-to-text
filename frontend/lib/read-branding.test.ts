import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import { cleanup, installDom } from "./test-dom";
import { readBranding, type Branding } from "./read-branding";

installDom();

const SIZE = { width: 160, height: 40 };
const ORGANIZATIONS = {
  default: { name: "Sundsvalls kommun", logo: "default", dark_logo: false, logo_sizes: null },
  named: { name: "Region Västernorrland", logo: null, dark_logo: false, logo_sizes: null },
  custom: { name: "Umeå kommun", logo: "custom", dark_logo: false, logo_sizes: { light: SIZE, dark: null } },
  both: { name: "Umeå kommun", logo: "custom", dark_logo: true, logo_sizes: { light: SIZE, dark: { width: 1, height: 1 } } },
} as const;

/** The marker's attribute as the backend (or the dev server) writes it: escaped the way Python's html.escape does. */
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const answer = (organization: unknown) => escape(JSON.stringify({ organization }));
const pageWith = (content: string | null) => {
  document.head.innerHTML = content === null ? "<title>Tal till text</title>" : `<meta name="eneo-branding" content="${content}">`;
};

let errors: string[];
const original = console.error;
beforeEach(() => {
  errors = [];
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
});
afterEach(() => {
  console.error = original;
  cleanup();
});

test("the organisation is read from the page's own marker, at once", () => {
  for (const organization of Object.values(ORGANIZATIONS)) {
    pageWith(answer(organization));
    assert.deepEqual(readBranding(), { organization } satisfies Branding);
  }
  assert.deepEqual(errors, []);
});

test("a name with quotes, brackets and ampersands comes out of the attribute as it went in", () => {
  const name = "A \"B\" <script>x</script> & 'C' </head>";
  pageWith(answer({ ...ORGANIZATIONS.named, name }));
  assert.equal(readBranding().organization?.name, name);
  assert.equal(document.querySelectorAll("script").length, 0);
});

test("no organisation is a valid answer, and not an error", () => {
  pageWith(answer(null));
  assert.deepEqual(readBranding(), { organization: null });
  assert.deepEqual(errors, []);
});

test("a marker nobody filled, a missing one, or content that is not the answer give the product name alone, with one error", () => {
  const both = ORGANIZATIONS.both;
  const wrong: [string, string | null][] = [
    ["no marker in the page", null],
    ["an empty marker", ""],
    ["not JSON", "{organization:"],
    ["an array", "[]"],
    ["null", "null"],
    ["a string", '"Umeå kommun"'],
    ["no organization key", "{}"],
    ["an organization that is a string", answer("Umeå kommun")],
    ["a name that is not text", answer({ ...both, name: 5 })],
    ["an empty name", answer({ ...both, name: "" })],
    ["a logo of another kind", answer({ ...both, logo: "remote" })],
    ["no dark_logo", answer({ name: "A", logo: null, logo_sizes: null })],
    ["a custom logo with no sizes", answer({ ...both, logo_sizes: null })],
    ["a dark logo with no size", answer({ ...both, logo_sizes: { light: SIZE, dark: null } })],
    ["a size for a dark logo that is not there", answer({ ...ORGANIZATIONS.custom, logo_sizes: both.logo_sizes })],
    ["a size with no logo", answer({ ...ORGANIZATIONS.named, logo_sizes: { light: SIZE, dark: null } })],
    ["a size of zero", answer({ ...ORGANIZATIONS.custom, logo_sizes: { light: { width: 0, height: 40 }, dark: null } })],
    ["a size with a fraction", answer({ ...ORGANIZATIONS.custom, logo_sizes: { light: { width: 10.5, height: 4 }, dark: null } })],
    ["a size that is text", answer({ ...ORGANIZATIONS.custom, logo_sizes: { light: { width: "160", height: 40 }, dark: null } })],
  ];
  for (const [what, content] of wrong) {
    errors = [];
    pageWith(content);
    assert.deepEqual(readBranding(), { organization: null }, what);
    assert.equal(errors.length, 1, `${what}: said so once`);
    assert.match(errors[0], /eneo-branding/, `${what}: says which marker`);
  }
});

test("the page makes no request for it", () => {
  const fetched: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((...args: unknown[]) => void fetched.push(args)) as unknown as typeof fetch;
  try {
    pageWith(answer(ORGANIZATIONS.default));
    readBranding();
    pageWith("");
    readBranding();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(fetched, []);
});
