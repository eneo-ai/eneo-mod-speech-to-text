import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FileText, Mic, Paperclip, PenLine } from "lucide-react";

import { FlowList, inputIcon } from "../components/FlowList";
import type { FlowSparsePublic } from "./api";

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

test("flow names are whole, however long; descriptions keep to two lines; the last used flow comes first", () => {
  const html = renderToStaticMarkup(
    createElement(FlowList, {
      lastFlowId: "rapport",
      groups: [
        {
          spaceId: "space-1",
          spaceName: "Kommunledningskontoret",
          flows: [
            flow("struktur", "Nämndmöte till strukturerat protokoll med beslut", { input_type: "audio", description: "Transkriberar ljud från ett nämndmöte." }),
            flow("rapport", "Nämndmöte till rapport", { input_type: "audio" }),
          ],
        },
      ],
    }),
  );
  const titles = [...html.matchAll(/data-slot="item-title" class="([^"]*)">([^<]*)</g)];
  assert.deepEqual(
    titles.map(([, , name]) => name),
    ["Nämndmöte till rapport", "Nämndmöte till strukturerat protokoll med beslut"],
  );
  for (const [, classes] of titles) assert.doesNotMatch(classes, /truncate|line-clamp/, "a name is never cut");
  assert.match(html, /<p data-slot="item-description" class="[^"]*line-clamp-2[^"]*">Transkriberar ljud från ett nämndmöte\.<\/p>/);
  assert.match(html, /<a[^>]*href="\/flows\/rapport"/);
  assert.doesNotMatch(html, /<h2/, "one space needs no heading");
  assert.equal(html.match(/role="listitem"/g)?.length, 2);
});

test("each space is a plain heading over its own rows", () => {
  const html = renderToStaticMarkup(
    createElement(FlowList, {
      lastFlowId: null,
      groups: [
        { spaceId: "a", spaceName: "Kommunledningskontoret", flows: [flow("1", "Nämndmöte till rapport")] },
        { spaceId: "b", spaceName: "Socialtjänsten", flows: [flow("2", "Intervju till sammanfattning", { space_id: "b" })] },
      ],
    }),
  );
  assert.deepEqual(
    [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map(([, name]) => name),
    ["Kommunledningskontoret", "Socialtjänsten"],
  );
  assert.equal(html.match(/role="list"/g)?.length, 2);
});
