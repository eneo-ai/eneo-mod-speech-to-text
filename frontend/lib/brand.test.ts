import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Brand, BrandingProvider } from "../components/Brand";
import type { Branding } from "./api";
import { cleanup, installDom, mount } from "./test-dom";

installDom();
afterEach(cleanup);

const render = (branding: Branding, href?: string) =>
  renderToStaticMarkup(createElement(BrandingProvider, { value: branding, children: createElement(Brand, { href }) }));

const images = (html: string) => [...html.matchAll(/<img ([^>]*)\/>/g)].map(([, attributes]) => attributes);

test("the default is Sundsvall's lockup: its mark, named, and the product's name", () => {
  const html = render({ organization: { name: "Sundsvalls kommun", logo: "default", dark_logo: false } }, "/flows");
  assert.match(html, /aria-label="Tal till text – Sundsvalls kommun"/);
  const [mark, ...others] = images(html);
  assert.deepEqual(others, [], "one mark");
  assert.match(mark, /src="\/brand\/sundsvalls-kommun-logotyp\.svg"/);
  assert.match(mark, /alt="Sundsvalls kommun"/);
  assert.match(mark, /data-brand-logo="default"/, "the one that is inverted in the dark mode");
  assert.match(html, />Tal till text</);
});

test("another organisation's logo is served same-origin and named by its alt; one for each mode when it has both", () => {
  const html = render({ organization: { name: "Umeå kommun", logo: "custom", dark_logo: true } }, "/flows");
  assert.match(html, /aria-label="Tal till text – Umeå kommun"/);
  const [light, dark, ...others] = images(html);
  assert.deepEqual(others, [], "one for light, one for dark");
  assert.match(light, /src="\/api\/branding\/logo\/light" alt="Umeå kommun"/);
  assert.match(light, /data-brand-logo="light"/);
  assert.match(dark, /src="\/api\/branding\/logo\/dark" alt="Umeå kommun"/);
  assert.match(dark, /data-brand-logo="dark"/);
  for (const image of [light, dark]) assert.doesNotMatch(image, /invert/, "a coloured logo is never inverted");

  const lightOnly = render({ organization: { name: "Umeå kommun", logo: "custom", dark_logo: false } });
  const [only, ...rest] = images(lightOnly);
  assert.deepEqual(rest, []);
  assert.match(only, /data-brand-logo="plain"/, "without a dark logo the light one shows in both modes");
});

test("a name without a logo shows as text, and a hidden organisation leaves the product name alone", () => {
  const named = render({ organization: { name: "Region Västernorrland", logo: null, dark_logo: false } }, "/flows");
  assert.doesNotMatch(named, /<img/);
  assert.match(named, />Region Västernorrland</);
  assert.match(named, /aria-label="Tal till text – Region Västernorrland"/);

  const hidden = render({ organization: null }, "/flows");
  assert.doesNotMatch(hidden, /<img|Sundsvall|separator/, "no mark and no divider");
  assert.match(hidden, /aria-label="Tal till text"/);
  assert.match(hidden, />Tal till text</);
});

test("without a destination the lockup is not a link", () => {
  const html = render({ organization: { name: "Sundsvalls kommun", logo: "default", dark_logo: false } });
  assert.doesNotMatch(html, /<a /);
  assert.match(html, />Tal till text</);
});

test("the stylesheet shows the logo of the colour mode and inverts Sundsvall's", () => {
  const css = readFileSync("app/globals.css", "utf8");
  assert.match(css, /html\.dark \[data-brand-logo="default"\]\s*\{[^}]*filter:\s*invert\(1\)/, "the black mark turns white in the dark mode");
  assert.match(css, /html\.dark \[data-brand-logo="light"\]\s*\{[^}]*display:\s*none/, "the light logo gives way to the dark one");
  assert.match(css, /html:not\(\.dark\) \[data-brand-logo="dark"\]\s*\{[^}]*display:\s*none/, "and the dark one stays out of the light mode");
});

test("the brand's link asks before it leaves the page, and stays when told to", async () => {
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { HeaderBrand } = await import("../components/AppHeader");
  const pushed: string[] = [];
  const router = { push: (to: string) => pushed.push(to), replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {} } as never;
  const asked: boolean[] = [];
  const { container, act } = await mount(
    createElement(AppRouterContext.Provider, {
      value: router,
      children: createElement(HeaderBrand, {
        linked: true,
        onLeave: (event) => {
          asked.push(true);
          event.preventDefault();
        },
      }),
    }),
  );
  const link = container.querySelector("a")!;
  assert.equal(link.getAttribute("href"), "/flows");
  await act(async () => link.click());
  assert.deepEqual(asked, [true], "asked once");
  assert.deepEqual(pushed, [], "and the page was not left");
});

test("the header brand of a page nobody has signed in to is not a link", async () => {
  const { HeaderBrand } = await import("../components/AppHeader");
  const html = renderToStaticMarkup(createElement(HeaderBrand, { linked: false }));
  assert.doesNotMatch(html, /<a /);
  assert.match(html, />Tal till text</);
});
