import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { readFileSync } from "node:fs";

import { brandingMarker } from "./branding-marker";
import { readBranding } from "./read-branding";
import { cleanup, installDom } from "./test-dom";

installDom();

const INDEX = readFileSync("index.html", "utf8");
const ORGANIZATION = { name: "Umeå kommun", logo: "custom", dark_logo: false, logo_sizes: { light: { width: 600, height: 48 }, dark: null } };

const transform = (plugin: ReturnType<typeof brandingMarker>, html = INDEX) => (plugin.transformIndexHtml as (html: string) => Promise<string>)(html);
const answering = (body: string, status = 200): typeof fetch => async () => new Response(body, { status });

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

test("the dev server writes the backend's answer into the page's marker, which the page then reads as in production", async () => {
  const name = "A \"B\" <script>x</script> & 'C' </head>";
  const body = JSON.stringify({ organization: { ...ORGANIZATION, name } });
  const page = await transform(brandingMarker("http://stub", answering(body)));

  assert.doesNotMatch(page, /<script>x/, "no element came out of the name");
  assert.equal(page.match(/name="eneo-branding"/g)?.length, 1);
  document.documentElement.innerHTML = page;
  assert.deepEqual(readBranding(), { organization: { ...ORGANIZATION, name } });
  assert.deepEqual(errors, []);
});

test("it asks for the branding of the backend it proxies to, fresh, and with a deadline", async () => {
  const asked: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    asked.push({ url: String(input), init });
    return new Response('{"organization":null}');
  };
  await transform(brandingMarker("http://127.0.0.1:8443", fetchImpl));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url, "http://127.0.0.1:8443/api/branding");
  assert.equal(asked[0].init?.cache, "no-store");
  assert.ok(asked[0].init?.signal, "a stalled backend cannot hold the page");
});

test("an answer that does not come, or is not the answer, leaves a valid null: the product name alone, and one error", async () => {
  const stalled: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
  const keepAlive = setTimeout(() => {}, 5_000);
  const cases: [string, typeof fetch][] = [
    ["a refusal", answering("nope", 502)],
    ["text that is not JSON", answering("<html>Bad gateway</html>")],
    ["a backend that is down", async () => Promise.reject(new TypeError("fetch failed"))],
    ["a backend that never answers", stalled],
  ];
  for (const [what, fetchImpl] of cases) {
    errors = [];
    const page = await transform(brandingMarker("http://stub", fetchImpl, 30));
    document.documentElement.innerHTML = page;
    assert.deepEqual(readBranding(), { organization: null }, what);
    assert.equal(errors.length, 1, `${what}: said once, by the dev server`);
    assert.match(errors[0], /branding/);
  }
  clearTimeout(keepAlive);
});

test("a page without the marker, or with two, stops the dev server as it stops the backend", async () => {
  const marker = '<meta name="eneo-branding" content="" />';
  assert.ok(INDEX.includes(marker), "the page holds the marker the backend replaces");
  for (const [what, html] of [
    ["none", INDEX.replace(marker, "")],
    ["two", INDEX.replace(marker, marker + marker)],
    ["a filled one", INDEX.replace('content=""', 'content="x"')],
  ]) {
    await assert.rejects(transform(brandingMarker("http://stub", answering("{}")), html), /index\.html.*eneo-branding/, what);
  }
});

test("it works for the dev server only: a build leaves the marker to the backend", () => {
  assert.equal(brandingMarker("http://stub").apply, "serve");
});
