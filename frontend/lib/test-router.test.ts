/**
 * react-router is an ES module, and the unit tests are compiled to CommonJS by tsc and run by node:test. These tests
 * show that the router loads and is driven that way (a memory router, a link, Back, a blocker) on the Node floor the
 * repository declares; if it did not, no component test could mount a router.
 */

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { button, cleanup, installDom, mount } from "./test-dom";
import { withRouter } from "./test-router";

installDom();
afterEach(cleanup);

/** A page with a link, a Back button and, when asked, a blocker that holds every departure until it is answered. */
async function openPage({ blocking }: { blocking: boolean }) {
  const { createElement } = await import("react");
  const { Link, useBlocker, useNavigate } = await import("react-router");
  function Page() {
    const navigate = useNavigate();
    const blocker = useBlocker(blocking);
    return createElement(
      "div",
      null,
      createElement(Link, { to: "/elsewhere" }, "Gå vidare"),
      createElement("button", { type: "button", onClick: () => void navigate(-1) }, "Bakåt"),
      blocker.state === "blocked"
        ? createElement(
            "div",
            { role: "alertdialog" },
            createElement("button", { type: "button", onClick: () => blocker.reset() }, "Stanna kvar"),
            createElement("button", { type: "button", onClick: () => blocker.proceed() }, "Lämna"),
          )
        : null,
    );
  }
  const { router, tree } = withRouter(createElement(Page), { path: "/page", entries: ["/before", "/page"] });
  return { router, ...(await mount(tree)) };
}

const link = (within: ParentNode) => within.querySelector("a")!;

test("a link click moves the memory router without loading a document, and Back returns", async () => {
  const { router, container, act } = await openPage({ blocking: false });
  assert.equal(router.state.location.pathname, "/page");
  assert.equal(link(container).getAttribute("href"), "/elsewhere");
  const document = window.document;
  await act(async () => link(container).click());
  assert.equal(router.state.location.pathname, "/elsewhere");
  assert.equal(window.document, document, "the same document");
  await act(async () => router.navigate(-1));
  assert.equal(router.state.location.pathname, "/page");
  await act(async () => router.navigate(-1));
  assert.equal(router.state.location.pathname, "/before");
});

test("withRouter lists the addresses the router moved to, and nothing for a page that stayed", async () => {
  const { createElement } = await import("react");
  const { router, visited, tree } = withRouter(createElement("p", null, "Sidan"), { path: "/page" });
  const { act } = await mount(tree);
  assert.deepEqual(visited, [], "the first address is where it started, not a move");
  await act(async () => router.navigate("/page?run=1", { replace: true }));
  await act(async () => router.navigate("/flows"));
  assert.deepEqual(visited, ["/page?run=1", "/flows"]);
});

test("a page's own navigate(-1) goes back one entry", async () => {
  const { router, container, act } = await openPage({ blocking: false });
  await act(async () => button(container, "Bakåt")!.click());
  assert.equal(router.state.location.pathname, "/before");
});

test("a blocker holds a departure, stays on request, and lets it through on request", async () => {
  const { router, container, act } = await openPage({ blocking: true });
  await act(async () => link(container).click());
  assert.equal(router.state.location.pathname, "/page", "held");
  assert.ok(container.querySelector('[role="alertdialog"]'), "the question is asked");
  await act(async () => button(container, "Stanna kvar")!.click());
  assert.equal(router.state.location.pathname, "/page", "still there");
  assert.equal(container.querySelector('[role="alertdialog"]'), null, "the question is gone");
  await act(async () => link(container).click());
  await act(async () => button(container, "Lämna")!.click());
  assert.equal(router.state.location.pathname, "/elsewhere", "let through");
});

test("a blocker holds Back as well", async () => {
  const { router, container, act } = await openPage({ blocking: true });
  await act(async () => button(container, "Bakåt")!.click());
  assert.equal(router.state.location.pathname, "/page", "held");
  await act(async () => button(container, "Lämna")!.click());
  assert.equal(router.state.location.pathname, "/before", "let through");
});
