import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { cleanup, installDom, mount } from "./test-dom";

installDom();
afterEach(cleanup);

/**
 * A flow page holding work the browser could not keep, at the entry of a run it opened from its setup (the entry
 * before). Its view is replaced by an entry that names another run.
 */
async function holdingWork() {
  const { createElement } = await import("react");
  const { createMemoryRouter, RouterProvider, useNavigate } = await import("react-router");
  const { useLeaveQuestion } = await import("../components/flow/useLeaveQuestion");
  let navigate!: ReturnType<typeof useNavigate>;
  function Flow() {
    navigate = useNavigate();
    useLeaveQuestion(true, "Det du har skrivit finns bara på sidan.", false, (next) => new URLSearchParams(next.search).get("run") !== "r1");
    return null;
  }
  const router = createMemoryRouter([{ path: "flows/:id", element: createElement(Flow) }], {
    initialEntries: ["/flows/f", "/flows/f?run=r1"],
    initialIndex: 1,
  });
  const view = await mount(createElement(RouterProvider, { router }));
  return { router, act: view.act, navigate: () => navigate };
}

test("Back to the setup that would replace the run shown, with work held, asks first: the run stays", async () => {
  const { router, act } = await holdingWork();
  await act(async () => void router.navigate(-1));
  assert.equal(router.state.location.search, "?run=r1");
  assert.equal([...router.state.blockers.values()][0]?.state, "blocked", "the question is asked");
});

test("the page writing its own address, with work held, is no departure", async () => {
  const { router, act, navigate } = await holdingWork();
  await act(async () => void navigate()({ search: "?run=r1&x=1" }, { replace: true }));
  assert.equal(router.state.location.search, "?run=r1&x=1");
});
