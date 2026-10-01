import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import { FileText, Mic, Paperclip, PenLine } from "lucide-react";

import { FlowList, inputIcon } from "../components/FlowList";
import type { FlowSparsePublic } from "./api";
import { cleanup, installDom, mount } from "./test-dom";

installDom();
afterEach(cleanup);

const flow = (id: string, name: string, overrides: Partial<FlowSparsePublic> = {}): FlowSparsePublic => ({
  id,
  name,
  space_id: "space-1",
  space_name: "Kommunledningskontoret",
  ...overrides,
});

test("a flow's icon says how it takes its input, from Eneo's input type", () => {
  assert.equal(inputIcon("audio"), Mic);
  assert.equal(inputIcon("document"), FileText);
  assert.equal(inputIcon("file"), Paperclip);
  assert.equal(inputIcon(null), PenLine, "only details: no phone, no microphone");
  assert.equal(inputIcon(undefined), PenLine);
});

test("an input type Eneo has not told us of asks only for details, as a flow with none does", () => {
  assert.equal(inputIcon("video"), PenLine);
});

const groupOf = (...flows: FlowSparsePublic[]) => [{ spaceId: "space-1", spaceName: "Kommunledningskontoret", flows }];

test("each flow is one link named by the flow and then its description; the last used flow comes first", async () => {
  const { container } = await mount(
    createElement(FlowList, {
      lastFlowId: "rapport",
      groups: groupOf(
        flow("struktur", "Nämndmöte till strukturerat protokoll med beslut", { input_type: "audio", description: "Transkriberar ljud från ett nämndmöte." }),
        flow("rapport", "Nämndmöte till rapport", { input_type: "audio" }),
      ),
    }),
  );
  const rows = [...container.querySelectorAll("ul[role=list] > li")];
  assert.equal(rows.length, 2, "two rows in one list");
  const links = rows.map((row) => row.querySelectorAll("a"));
  assert.deepEqual(links.map((own) => own.length), [1, 1], "one link in each row");
  const [rapport, struktur] = links.map(([link]) => link);
  assert.deepEqual([rapport.getAttribute("href"), struktur.getAttribute("href")], ["/flows/rapport", "/flows/struktur"]);
  assert.equal(rapport.firstElementChild?.textContent, "Nämndmöte till rapport", "the name is the link's first words");
  assert.equal(struktur.firstElementChild?.textContent, "Nämndmöte till strukturerat protokoll med beslut");
  assert.equal(rapport.textContent, "Nämndmöte till rapport", "no description, no empty line");
  assert.equal(struktur.textContent, "Nämndmöte till strukturerat protokoll med beslutTranskriberar ljud från ett nämndmöte.", "the description is inside the link");
  assert.equal(container.querySelectorAll("h2").length, 0, "one space needs no heading");
});

test("each space is a named region with a plain heading over its own rows", async () => {
  const { container } = await mount(
    createElement(FlowList, {
      lastFlowId: null,
      groups: [
        { spaceId: "a", spaceName: "Kommunledningskontoret", flows: [flow("1", "Nämndmöte till rapport")] },
        { spaceId: "b", spaceName: "Socialtjänsten", flows: [flow("2", "Intervju till sammanfattning", { space_id: "b" })] },
      ],
    }),
  );
  assert.deepEqual(
    [...container.querySelectorAll("h2")].map((heading) => heading.textContent),
    ["Kommunledningskontoret", "Socialtjänsten"],
  );
  const regions = [...container.querySelectorAll("[role=region]")];
  assert.deepEqual(
    regions.map((region) => document.getElementById(region.getAttribute("aria-labelledby")!)?.textContent),
    ["Kommunledningskontoret", "Socialtjänsten"],
    "each region is named by its heading",
  );
  assert.equal(container.querySelectorAll("ul[role=list]").length, 2);
});

test("a row's link is Next's, so opening a flow is the router's push and not a page load (tests/e2e/flow-list.spec.ts proves it in the app)", async () => {
  // Under node `next/link` is Next's pages Link, which reads this context where the app's reads another: both are Next's.
  const { RouterContext } = await import("next/dist/shared/lib/router-context.shared-runtime");
  const { ModuleProviders } = await import("@/kit/ModuleProviders");
  const pushed: string[] = [];
  const router = { push: (to: string) => pushed.push(to), replace() {}, prefetch: async () => {}, beforePopState() {}, events: {} } as never;
  const { container, act } = await mount(
    createElement(
      RouterContext.Provider,
      { value: router },
      createElement(ModuleProviders, null, createElement(FlowList, { lastFlowId: null, groups: groupOf(flow("rapport", "Nämndmöte till rapport")) })),
    ),
  );
  const link = container.querySelector("a")!;
  assert.equal(link.hasAttribute("to"), false, "the design system's `to` is not put on the link");
  await act(async () => link.click());
  assert.deepEqual(pushed, ["/flows/rapport"]);
});
