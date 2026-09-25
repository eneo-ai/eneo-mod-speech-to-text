import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Brand, BrandingProvider } from "../components/Brand";
import type { Branding } from "./api";

const render = (branding: Branding, href?: string) =>
  renderToStaticMarkup(createElement(BrandingProvider, { value: branding, children: createElement(Brand, { href }) }));

test("the default is Sundsvall's lockup exactly as before", () => {
  const html = render({ organization: { name: "Sundsvalls kommun", logo: "default", dark_logo: false } }, "/flows");
  assert.match(html, /aria-label="Tal till text – Sundsvalls kommun"/);
  assert.match(html, /<img src="\/brand\/sundsvalls-kommun-logotyp\.svg" alt="Sundsvalls kommun" class="block h-10 w-auto dark:invert"\/>/);
  assert.match(html, />Tal till text</);
});

test("another organisation's logo is served same-origin, named by its alt, bounded in height", () => {
  const html = render({ organization: { name: "Umeå kommun", logo: "custom", dark_logo: true } }, "/flows");
  assert.match(html, /aria-label="Tal till text – Umeå kommun"/);
  const images = [...html.matchAll(/<img ([^>]*)\/>/g)].map(([, attributes]) => attributes);
  assert.equal(images.length, 2, "one for light, one for dark");
  assert.match(images[0], /src="\/api\/branding\/logo\/light" alt="Umeå kommun"/);
  assert.match(images[0], /dark:hidden/);
  assert.match(images[1], /src="\/api\/branding\/logo\/dark" alt="Umeå kommun"/);
  assert.match(images[1], /hidden dark:block/);
  for (const image of images) {
    assert.match(image, /h-10/, "the same height as Sundsvall's logo");
    assert.match(image, /object-contain/, "a wide logo keeps its shape");
    assert.match(image, /max-w-/, "and cannot push the header wider");
    assert.doesNotMatch(image, /invert/, "a coloured logo is never inverted");
  }

  const lightOnly = render({ organization: { name: "Umeå kommun", logo: "custom", dark_logo: false } });
  assert.equal(lightOnly.match(/<img /g)?.length, 1);
  assert.doesNotMatch(lightOnly, /dark:hidden/, "without a dark logo the light one shows in both themes");
});

test("a name without a logo shows as text, and a hidden organisation leaves the product name alone", () => {
  const named = render({ organization: { name: "Region Västernorrland", logo: null, dark_logo: false } }, "/flows");
  assert.doesNotMatch(named, /<img/);
  assert.match(named, />Region Västernorrland</);
  assert.match(named, /aria-label="Tal till text – Region Västernorrland"/);

  const hidden = render({ organization: null }, "/flows");
  assert.doesNotMatch(hidden, /<img|Sundsvall|bg-rule/, "no mark and no divider");
  assert.match(hidden, /aria-label="Tal till text"/);
  assert.match(hidden, />Tal till text</);
});
