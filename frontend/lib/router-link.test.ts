import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { ComponentProps } from "react";

import { cleanup, installDom, mount } from "./test-dom";
import { withRouter } from "./test-router";

installDom();
afterEach(cleanup);

/**
 * One link under a router. A click that the router handled is a click whose default it prevented (it navigates
 * itself); a plain anchor leaves the default alone. Both are cancelled at the document, since jsdom cannot load a page.
 */
async function press(props: ComponentProps<typeof import("@/kit/RouterLink").RouterLink>) {
  const { createElement } = await import("react");
  const { RouterLink } = await import("@/kit/RouterLink");
  const { router, tree } = withRouter(createElement(RouterLink, props, "Länk"));
  const { container, act } = await mount(tree);
  const anchor = container.querySelector("a")!;
  let handledByRouter: boolean | null = null;
  const seen = (event: Event) => {
    handledByRouter = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener("click", seen);
  await act(async () => anchor.click());
  document.removeEventListener("click", seen);
  return { anchor, router, handledByRouter };
}

test("a link to a page of the app is the router's: the click navigates without loading a document", async () => {
  const { anchor, router, handledByRouter } = await press({ href: "/flows" });
  assert.equal(anchor.getAttribute("href"), "/flows");
  assert.equal(handledByRouter, true, "the router took the click");
  assert.equal(router.state.location.pathname, "/flows");
});

test("the path keeps its query and its hash", async () => {
  const { router, handledByRouter } = await press({ href: "/flows/abc?run=1#top" });
  assert.equal(handledByRouter, true);
  assert.equal(router.state.location.pathname, "/flows/abc");
  assert.equal(router.state.location.search, "?run=1");
  assert.equal(router.state.location.hash, "#top");
});

test("a link to the page itself with target _self is still the router's", async () => {
  const { handledByRouter, router } = await press({ href: "/flows", target: "_self" });
  assert.equal(handledByRouter, true);
  assert.equal(router.state.location.pathname, "/flows");
});

for (const [name, props] of [
  ["a fragment", { href: "#x" }],
  ["mailto:", { href: "mailto:stod@example.se" }],
  ["another origin", { href: "https://example.se/" }],
  ["a protocol-relative address", { href: "//example.se/flows" }],
  ["a file of the API", { href: "/api/eneo/flows/abc/runs/def/artifacts/ghi/content" }],
  ["a file of the API in a new tab", { href: "/api/eneo/flows/abc/runs/def/artifacts/ghi/content", target: "_blank" }],
  ["a download", { href: "/flows", download: "anteckningar.docx" }],
  ["a page in a new tab", { href: "/flows", target: "_blank" }],
] as const) {
  test(`${name} is a plain anchor that the router never sees`, async () => {
    const { anchor, router, handledByRouter } = await press(props);
    assert.equal(anchor.getAttribute("href"), props.href, "the address as given");
    assert.equal(handledByRouter, false, "the router left the click alone");
    assert.equal(router.state.location.pathname, "/", "the router did not move");
  });
}

test("`to`, which the design system passes beside `href`, never reaches the anchor", async () => {
  for (const href of ["/flows", "https://example.se/"]) {
    const { anchor } = await press({ href, to: href });
    assert.equal(anchor.hasAttribute("to"), false, href);
    await cleanup();
  }
});

test("the text, the name and the other attributes of the link come through", async () => {
  const { anchor } = await press({ href: "/flows", "aria-label": "Till flödena", rel: "noopener" });
  assert.equal(anchor.textContent, "Länk");
  assert.equal(anchor.getAttribute("aria-label"), "Till flödena");
  assert.equal(anchor.getAttribute("rel"), "noopener");
});
