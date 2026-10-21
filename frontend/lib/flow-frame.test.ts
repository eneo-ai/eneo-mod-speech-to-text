import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement, useState } from "react";
import { cleanup, installDom, mount } from "./test-dom";
import { withRouter } from "./test-router";

installDom();
afterEach(cleanup);

/** A page's router, colour mode and signed-in user, as the app gives them. */
async function signedIn(element: import("react").ReactElement) {
  const { AuthenticatedUserContext } = await import("../components/AuthGate");
  const { ColorModeProvider } = await import("@/kit/ColorModeProvider");
  const user = { id: "user-1", email: "anna@example.se", username: "Anna" };
  return withRouter(createElement(ColorModeProvider, null, createElement(AuthenticatedUserContext.Provider, { value: user }, element))).tree;
}

const FLOW = { id: "flow-1", name: "Nämndmöte", description: null, published_version: 1 } as unknown as import("./api").FlowPublished;
const FIELDS = [{ name: "deltagare", label: "Deltagare", type: "text" }];
const CONTRACT = { flow_id: "flow-1", published_flow_version: 1, form_fields: FIELDS, steps_requiring_input: [] } as unknown as import("./api").RunContract;

test("the frame is the shell's one main region, with the page's skip link and a named bar", async () => {
  const { FlowFrame } = await import("../components/flow/FlowFrame");
  const view = await mount(await signedIn(createElement(FlowFrame, { children: createElement("p", null, "Innehåll") })));
  assert.equal(view.container.querySelectorAll('[role="main"], main').length, 1, "no page renders a second main");
  assert.ok(view.container.querySelector('[role="banner"] nav[aria-label="Tal till text"]'), "the bar is the banner's navigation");
  assert.ok(view.container.querySelector('[data-testid="skip-to-content"]'), "the skip link comes with the shell");
});

test("the way back is one link named Alla flöden in the bar at every width, the brand a second one from a tablet's width, with the account; locked, the page offers none and the brand stands alone", async (t) => {
  const { FlowFrame } = await import("../components/flow/FlowFrame");
  const exits = (container: HTMLElement) => ({
    back: [...container.querySelectorAll('[role="banner"] a[href="/flows"]')].filter((a) => a.textContent?.trim() === "Alla flöden").length,
    links: container.querySelectorAll('a[href="/flows"]').length,
    account: [...container.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label")?.startsWith("Öppna konto")).length,
    brand: (container.querySelector('[role="banner"]')?.textContent ?? "").includes("Tal till text"),
  });
  const phone = await mount(await signedIn(createElement(FlowFrame, { children: null })));
  assert.deepEqual(exits(phone.container), { back: 1, links: 1, account: 1, brand: false }, "on a phone the bar keeps its room for the way back");
  await phone.unmount();
  const lockedPhone = await mount(await signedIn(createElement(FlowFrame, { locked: true, children: null })));
  assert.deepEqual(exits(lockedPhone.container), { back: 0, links: 0, account: 0, brand: true }, "while the page waits the brand fills the bar");
  await lockedPhone.unmount();
  const fake = window.matchMedia;
  t.mock.method(window, "matchMedia", (query: string) => ({ ...fake(query), matches: query === "(min-width: 768px)" }));
  const open = await mount(await signedIn(createElement(FlowFrame, { children: null })));
  assert.deepEqual(exits(open.container), { back: 1, links: 2, account: 1, brand: true }, "the brand beside it leads to the flows too");
  await open.unmount();
  const locked = await mount(await signedIn(createElement(FlowFrame, { locked: true, children: null })));
  assert.deepEqual(exits(locked.container), { back: 0, links: 0, account: 0, brand: true });
});

test("the bar holds no flow name, so it stays one line: a view with no aside names the flow in its own first lines", async () => {
  const { FlowFrame } = await import("../components/flow/FlowFrame");
  const view = await mount(await signedIn(createElement(FlowFrame, { children: null })));
  assert.equal(view.container.querySelector('[role="banner"]')!.querySelectorAll("h1, p").length, 0, "no heading, no text in the bar");
});

test("the flow's page keeps one h1: the flow's name on setup, the state's own heading on a run's states", async () => {
  const { FlowAside } = await import("../components/flow/FlowAside");
  const headings = async (titleIsHeading: boolean) => {
    const view = await mount(await signedIn(createElement(FlowAside, { published: FLOW, titleIsHeading, details: null })));
    const found = [...view.container.querySelectorAll("h1")].map((h) => h.textContent);
    await view.unmount();
    return found;
  };
  assert.deepEqual(await headings(true), ["Nämndmöte"]);
  assert.deepEqual(await headings(false), []);
});

test("the aside says only what the flow has: no description, no classification and no form leave a name and nothing else", async () => {
  const { FlowAside } = await import("../components/flow/FlowAside");
  const view = await mount(await signedIn(createElement(FlowAside, { published: FLOW, compact: true, details: null, summary: null })));
  assert.equal(view.container.querySelectorAll('[role="note"]').length, 0);
  assert.equal(view.container.querySelectorAll("button").length, 0, "no fold without a summary");
  assert.equal(view.container.querySelectorAll("p").length, 0, "no empty description");
  assert.equal(view.container.querySelectorAll("a").length, 0, "the way back is the bar's");
  await view.unmount();
  const described = await mount(
    await signedIn(createElement(FlowAside, { published: { ...FLOW, description: "Skapar protokoll." }, details: null })),
  );
  assert.match(described.container.textContent ?? "", /Skapar protokoll\./);
});

test("the folded details are one named button; closed they stay in the page, so what was typed survives", async () => {
  const { FlowAside } = await import("../components/flow/FlowAside");
  function Folded() {
    const [open, setOpen] = useState(false);
    return createElement(FlowAside, {
      published: FLOW,
      compact: true,
      details: createElement("input", { "aria-label": "Deltagare", defaultValue: "Anna" }),
      summary: "Deltagare: Anna",
      open,
      onOpenChange: setOpen,
    });
  }
  const view = await mount(await signedIn(createElement(Folded)));
  const fold = [...view.container.querySelectorAll("button")].find((b) => b.getAttribute("aria-expanded") !== null)!;
  const heard = fold.cloneNode(true) as Element;
  heard.querySelectorAll("[aria-hidden]").forEach((node) => node.remove());
  assert.equal(heard.textContent?.trim(), "Uppgifter, Deltagare: Anna", "its name: what the line is for, the word heard once");
  assert.equal(fold.querySelector("[aria-hidden]")?.textContent, "Uppgifter", "the eye reads what the line is for too");
  assert.equal(fold.getAttribute("aria-expanded"), "false");
  const field = view.container.querySelector<HTMLInputElement>('input[aria-label="Deltagare"]');
  assert.ok(field?.isConnected && field.value === "Anna", "mounted while folded");
  await view.act(async () => fold.click());
  assert.equal(fold.getAttribute("aria-expanded"), "true");
});

test("a run's page names what waits while offline in a status region that is always there", async () => {
  const { FlowRunPage } = await import("../components/flow/FlowRunPage");
  const view = await mount(
    await signedIn(createElement(FlowRunPage, { published: FLOW, contract: CONTRACT, input: null, version: 1, offline: "run", children: createElement("h1", null, "Dokumentet skapas") })),
  );
  assert.ok(view.container.querySelector('[role="main"] [role="status"]'), "the region is rendered also while online, so the change is announced once");
});

test("the page that loads says so, in one status region, and is busy", async () => {
  const { FlowSkeleton } = await import("../components/flow/FlowPageStates");
  const view = await mount(await signedIn(createElement(FlowSkeleton)));
  const status = [...view.container.querySelectorAll('[role="status"]')].filter((s) => s.textContent === "Laddar flödet…");
  assert.equal(status.length, 1);
  assert.ok(view.container.querySelector('[aria-busy="true"]'));
  assert.equal(view.container.querySelectorAll('[role="main"]').length, 1, "in the same frame as the page it becomes");
  assert.deepEqual([...view.container.querySelectorAll("h1")].map((h) => h.textContent), ["Tal till text"], "a page has its h1 while it loads too");
});

test("the page for a flow that cannot be opened has one h1, one way back (the bar's), and Försök igen only where trying again can help", async () => {
  const { FlowUnavailable } = await import("../components/flow/FlowPageStates");
  const { ApiError } = await import("./api");
  const gone = await mount(await signedIn(createElement(FlowUnavailable, { error: new ApiError(404, "Flow not found.", null, "not_found") })));
  assert.deepEqual([...gone.container.querySelectorAll("h1")].map((h) => h.textContent), ["Flödet är inte längre tillgängligt."]);
  const back = [...gone.container.querySelectorAll('a[href="/flows"]')].filter((a) => a.textContent?.trim() === "Alla flöden");
  assert.deepEqual(back.map((a) => Boolean(a.closest('[role="banner"]'))), [true]);
  assert.ok(![...gone.container.querySelectorAll("button")].some((b) => b.textContent === "Försök igen"));
  await gone.unmount();
  const down = await mount(await signedIn(createElement(FlowUnavailable, { error: new ApiError(503, "Service Unavailable", null) })));
  assert.ok([...down.container.querySelectorAll("button")].some((b) => b.textContent === "Försök igen"));
});

test("a state's card passes its attributes to the card", async () => {
  const { StateCard } = await import("../components/flow/StateCard");
  const view = await mount(createElement(StateCard, { "aria-busy": "true", children: createElement("p", null, "Dokumentet skapas") }));
  assert.equal(view.container.querySelector('[aria-busy="true"]')?.textContent, "Dokumentet skapas");
});
