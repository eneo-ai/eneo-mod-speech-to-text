import assert from "node:assert/strict";
import test from "node:test";

import type { FlowSparsePublic, OffsetPaginatedResponse } from "./api";
import {
  DISCOVERY_PAGE_CAP,
  DISCOVERY_PAGE_SIZE,
  discoverFlows,
  groupBySpace,
  listCreateLabels,
} from "./flow-discovery";

const flow = (id: string, spaceId: string, spaceName: string): FlowSparsePublic => ({
  id,
  name: `Flöde ${id}`,
  space_id: spaceId,
  space_name: spaceName,
  published_version: 1,
  input_type: "audio",
});

const page = (items: FlowSparsePublic[], hasMore: boolean): OffsetPaginatedResponse<FlowSparsePublic> => ({
  items,
  count: items.length,
  has_more: hasMore,
});

test("one discovery reads published flows across the user's spaces, page by page to the end", async () => {
  const requests: { limit: number; offset: number }[] = [];
  const first = Array.from({ length: DISCOVERY_PAGE_SIZE }, (_, i) => flow(`a${i}`, "space-a", "Nämnden"));
  const { groups, truncated } = await discoverFlows({
    list: async (params) => {
      requests.push(params);
      return params.offset === 0 ? page(first, true) : page([flow("b0", "space-b", "Arkivet")], false);
    },
  });

  // No space named: every space the user belongs to.
  assert.deepEqual(requests, [
    { limit: DISCOVERY_PAGE_SIZE, offset: 0 },
    { limit: DISCOVERY_PAGE_SIZE, offset: DISCOVERY_PAGE_SIZE },
  ]);
  assert.equal(truncated, false);
  assert.equal(groups.reduce((sum, group) => sum + group.flows.length, 0), DISCOVERY_PAGE_SIZE + 1);
});

test("paging stops at the cap and says the list is cut", async () => {
  let calls = 0;
  const { truncated } = await discoverFlows({
    list: async (params) => {
      calls += 1;
      return page([flow(`x${params.offset}`, "s", "S")], true);
    },
  });
  assert.equal(calls, DISCOVERY_PAGE_CAP);
  assert.equal(truncated, true);
});

test("flows group on their space, named by space_name, spaces in Swedish order and flows in Eneo's", () => {
  const groups = groupBySpace([
    flow("1", "s-social", "Socialtjänsten"),
    flow("2", "s-arende", "Ärendehantering"),
    flow("3", "s-social", "Socialtjänsten"),
    flow("4", "s-ks", "Kommunstyrelsen"),
  ]);

  assert.deepEqual(
    groups.map((group) => [group.spaceName, group.flows.map((f) => f.id)]),
    [
      ["Kommunstyrelsen", ["4"]],
      ["Socialtjänsten", ["1", "3"]],
      ["Ärendehantering", ["2"]],
    ],
  );
  // One space is one group: the list then shows no space heading.
  assert.equal(groupBySpace([flow("1", "s", "Min yta"), flow("2", "s", "Min yta")]).length, 1);
});

test("the real client sends one published_only request per page and never asks for spaces", async (t) => {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    const offset = Number(new URL(String(url), "http://module.test").searchParams.get("offset"));
    const body = offset === 0 ? page([flow("1", "s", "S")], true) : page([flow("2", "s", "S")], false);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const { groups } = await discoverFlows();

  assert.deepEqual(urls, [
    `/api/eneo/flows/?published_only=true&limit=${DISCOVERY_PAGE_SIZE}&offset=0`,
    `/api/eneo/flows/?published_only=true&limit=${DISCOVERY_PAGE_SIZE}&offset=1`,
  ]);
  assert.ok(urls.every((url) => !url.includes("/spaces/") && !url.includes("/run-contract/") && !url.includes("space_id")));
  assert.deepEqual(groups[0].flows.map((f) => f.id), ["1", "2"]);
});

test("an unsent recording's action on the flow list follows how its flow gives the result, as on the flow page", () => {
  const groups = groupBySpace([
    { ...flow("text", "space-a", "Nämnden"), delivery: "payload" },
    { ...flow("pdf", "space-a", "Nämnden"), delivery: "artifact" },
    flow("older", "space-a", "Nämnden"),
  ]);
  // One lookup for the list, asked once per unsent recording.
  const label = listCreateLabels(groups);
  assert.equal(label("text"), "Skapa text");
  assert.equal(label("pdf"), "Skapa dokument");
  assert.equal(label("older"), "Skapa dokument", "an Eneo whose list does not say: as before");
  assert.equal(label("gone"), "Skapa dokument", "a flow no longer listed");
  assert.equal(listCreateLabels(null)("text"), "Skapa dokument", "while the list is read");
});
