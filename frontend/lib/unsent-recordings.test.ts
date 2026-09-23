import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { recordingSummary, UnsentRecordings } from "../components/UnsentRecordings";
import type { StoredRecording } from "./recording-store";

const at = (day: number, hours: number, minutes: number) =>
  new Date(2026, 8, day, hours, minutes).getTime();

const recording = (id: string, durationMs: number, startedAt: number): StoredRecording => ({
  id,
  ownerId: "user-1",
  flowId: "flow-1",
  flowName: "Nämndmöte till rapport",
  stepId: "step-audio",
  inputMode: "record",
  mimeType: "audio/webm;codecs=opus",
  startedAt,
  durationMs,
  state: "stopped",
  parts: [],
  runId: null,
});

test("an unsent recording is told apart by flow, length and when it was made", () => {
  const now = at(23, 15, 0);
  assert.equal(
    recordingSummary(recording("a", 42 * 60_000, at(23, 10, 12)), { withFlowName: true, now }),
    "Osänd inspelning, Nämndmöte till rapport, 42 min, i dag 10:12",
  );
  assert.equal(
    recordingSummary(recording("b", 65 * 60_000, at(22, 16, 40)), { now }),
    "Osänd inspelning, 1 h 5 min, i går 16:40",
  );
  const older = at(20, 9, 5);
  assert.equal(
    recordingSummary(recording("c", 20_000, older), { now }),
    `Osänd inspelning, 20 s, ${new Date(older).toLocaleDateString("sv-SE", { day: "numeric", month: "short" })} 09:05`,
  );
});

test("each unsent recording offers Skicka, Spara som fil and Ta bort, described by its summary", () => {
  const html = renderToStaticMarkup(
    createElement(UnsentRecordings, {
      recordings: [recording("a", 60_000, at(23, 10, 12)), recording("b", 120_000, at(23, 9, 0))],
      onSend: () => {},
      withFlowName: true,
    }),
  );
  assert.match(html, /2 inspelningar är inte skickade/);
  const rows = html.split("<li").slice(1);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const summaryId = /<p id="([^"]+)"/.exec(row)?.[1];
    assert.ok(summaryId, "the summary has an id");
    const described = [...row.matchAll(/aria-describedby="([^"]+)"[^>]*>([^<]+)</g)];
    assert.deepEqual(
      described.map(([, id, label]) => [id, label]),
      [
        [summaryId, "Skicka"],
        [summaryId, "Spara som fil"],
        [summaryId, "Ta bort"],
      ],
    );
  }
  assert.equal(
    renderToStaticMarkup(createElement(UnsentRecordings, { recordings: [], onSend: () => {} })),
    "",
  );
});
