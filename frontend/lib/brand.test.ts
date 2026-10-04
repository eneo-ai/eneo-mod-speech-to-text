import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Brand, BrandingProvider } from "../components/Brand";
import type { Branding } from "./read-branding";
import { RootHydrateFallback } from "../routes/Root";
import { cleanup, installDom, mount } from "./test-dom";
import { inStaticRouter, withRouter } from "./test-router";

installDom();
afterEach(cleanup);

const render = (branding: Branding, href?: string) =>
  renderToStaticMarkup(inStaticRouter(createElement(BrandingProvider, { value: branding, children: createElement(Brand, { href }) })));

const images = (html: string) => [...html.matchAll(/<img ([^>]*)\/>/g)].map(([, attributes]) => attributes);

test("the default is Sundsvall's lockup: its mark, named, and the product's name", () => {
  const html = render({ organization: { name: "Sundsvalls kommun", logo: "default", dark_logo: false, logo_sizes: null } }, "/flows");
  assert.match(html, /aria-label="Tal till text – Sundsvalls kommun"/);
  const [mark, ...others] = images(html);
  assert.deepEqual(others, [], "one mark");
  assert.match(mark, /src="\/brand\/sundsvalls-kommun-logotyp\.svg"/);
  assert.match(mark, /alt="Sundsvalls kommun"/);
  assert.match(mark, /data-brand-logo="default"/, "the one that is inverted in the dark mode");
  assert.match(html, />Tal till text</);
});

test("another organisation's logo is served same-origin and named by its alt; one for each mode when it has both", () => {
  const html = render({ organization: { name: "Umeå kommun", logo: "custom", dark_logo: true, logo_sizes: { light: { width: 600, height: 48 }, dark: { width: 160, height: 40 } } } }, "/flows");
  assert.match(html, /aria-label="Tal till text – Umeå kommun"/);
  const [light, dark, ...others] = images(html);
  assert.deepEqual(others, [], "one for light, one for dark");
  assert.match(light, /src="\/api\/branding\/logo\/light" alt="Umeå kommun"/);
  assert.match(light, /data-brand-logo="light"/);
  assert.match(dark, /src="\/api\/branding\/logo\/dark" alt="Umeå kommun"/);
  assert.match(dark, /data-brand-logo="dark"/);
  for (const image of [light, dark]) assert.doesNotMatch(image, /invert/, "a coloured logo is never inverted");

  const lightOnly = render({ organization: { name: "Umeå kommun", logo: "custom", dark_logo: false, logo_sizes: { light: { width: 600, height: 48 }, dark: null } } });
  const [only, ...rest] = images(lightOnly);
  assert.deepEqual(rest, []);
  assert.match(only, /data-brand-logo="plain"/, "without a dark logo the light one shows in both modes");
});

test("every logo is drawn with its width and height, so its room is kept before the file arrives", () => {
  const both = render({ organization: { name: "Umeå kommun", logo: "custom", dark_logo: true, logo_sizes: { light: { width: 600, height: 48 }, dark: { width: 160, height: 40 } } } });
  const [light, dark] = images(both);
  assert.match(light, /width="600" height="48"/);
  assert.match(dark, /width="160" height="40"/);

  // The bundled mark is a file of the page's own: its proportions are those of its viewBox (277.4 x 110.3), tenfold.
  const [bundled] = images(render({ organization: { name: "Sundsvalls kommun", logo: "default", dark_logo: false, logo_sizes: null } }));
  assert.match(bundled, /width="2774" height="1103"/);
  assert.match(readFileSync("public/brand/sundsvalls-kommun-logotyp.svg", "utf8"), /viewBox="0 0 277\.4 110\.3"/, "the constant is the file's");
});

test("the first frame, before any page has loaded, already names the organisation", () => {
  document.head.innerHTML = `<meta name="eneo-branding" content="${JSON.stringify({
    organization: { name: "Umeå kommun", logo: "custom", dark_logo: false, logo_sizes: { light: { width: 600, height: 48 }, dark: null } },
  }).replace(/"/g, "&quot;")}">`;
  const html = renderToStaticMarkup(inStaticRouter(createElement(RootHydrateFallback)));
  const [mark] = images(html);
  assert.match(mark, /src="\/api\/branding\/logo\/light" alt="Umeå kommun" width="600" height="48"/);
});

test("a name without a logo shows as text, and a hidden organisation leaves the product name alone", () => {
  const named = render({ organization: { name: "Region Västernorrland", logo: null, dark_logo: false, logo_sizes: null } }, "/flows");
  assert.doesNotMatch(named, /<img/);
  assert.match(named, />Region Västernorrland</);
  assert.match(named, /aria-label="Tal till text – Region Västernorrland"/);

  const hidden = render({ organization: null }, "/flows");
  assert.doesNotMatch(hidden, /<img|Sundsvall|separator/, "no mark and no divider");
  assert.match(hidden, /aria-label="Tal till text"/);
  assert.match(hidden, />Tal till text</);
});

test("without a provider no organisation is named: the backend's branding is the one owner of who is shown", () => {
  const html = renderToStaticMarkup(inStaticRouter(createElement(Brand, { href: "/flows" })));
  assert.doesNotMatch(html, /<img|Sundsvall/);
  assert.match(html, /aria-label="Tal till text"/);
});

test("without a destination the lockup is not a link", () => {
  const html = render({ organization: { name: "Sundsvalls kommun", logo: "default", dark_logo: false, logo_sizes: null } });
  assert.doesNotMatch(html, /<a /);
  assert.match(html, />Tal till text</);
});

test("the stylesheet shows the logo of the colour mode and inverts Sundsvall's", () => {
  const css = readFileSync("styles/globals.css", "utf8");
  assert.match(css, /html\.dark \[data-brand-logo="default"\]\s*\{[^}]*filter:\s*invert\(1\)/, "the black mark turns white in the dark mode");
  assert.match(css, /html\.dark \[data-brand-logo="light"\]\s*\{[^}]*display:\s*none/, "the light logo gives way to the dark one");
  assert.match(css, /html:not\(\.dark\) \[data-brand-logo="dark"\]\s*\{[^}]*display:\s*none/, "and the dark one stays out of the light mode");
});

test("the brand's link asks before it leaves the page, and stays when told to", async () => {
  const { HeaderBrand } = await import("../components/AppHeader");
  const asked: boolean[] = [];
  const { router, tree } = withRouter(
    createElement(HeaderBrand, {
      linked: true,
      onLeave: (event) => {
        asked.push(true);
        event.preventDefault();
      },
    }),
    { path: "/start" },
  );
  const { container, act } = await mount(tree);
  const link = container.querySelector("a")!;
  assert.equal(link.getAttribute("href"), "/flows");
  await act(async () => link.click());
  assert.deepEqual(asked, [true], "asked once");
  assert.equal(router.state.location.pathname, "/start", "and the page was not left");
});

test("the header brand of a page nobody has signed in to is not a link", async () => {
  const { HeaderBrand } = await import("../components/AppHeader");
  const html = renderToStaticMarkup(createElement(HeaderBrand, { linked: false }));
  assert.doesNotMatch(html, /<a /);
  assert.match(html, />Tal till text</);
});
