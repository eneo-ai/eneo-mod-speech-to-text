import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { recordingDetails, UnsentRecordings } from "../components/UnsentRecordings";
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

test("an unsent recording keeps the name it was made with, then its flow and length", () => {
  assert.equal(recordingDetails(recording("a", 42 * 60_000, at(23, 10, 12)), { withFlowName: true }), "Nämndmöte till rapport · 42 min");
  assert.equal(recordingDetails(recording("b", 65 * 60_000, at(22, 16, 40))), "1 h 5 min");
  const html = renderToStaticMarkup(
    createElement(UnsentRecordings, { recordings: [recording("c", 30_000, at(20, 9, 5))], onSend: () => {}, withFlowName: true }),
  );
  // The name the ready panel shows (lib/format recordingName), then its flow and length, at the body's size.
  assert.match(html, /<p class="text-\[17px\][^"]*">Inspelning 20 sep 09:05<\/p><p class="text-\[15px\][^"]*">Nämndmöte till rapport · 30 s<\/p>/);
  assert.doesNotMatch(html, /text-\[1[23]px\]/, "no text below the body scale");
});

test("one unsent recording is spoken of in the singular", () => {
  const one = renderToStaticMarkup(
    createElement(UnsentRecordings, { recordings: [recording("a", 60_000, at(23, 10, 12))], onSend: () => {} }),
  );
  assert.match(one, /En inspelning är inte skickad/);
  assert.match(one, /Den finns kvar på den här enheten tills den har skickats\./);
  const two = renderToStaticMarkup(
    createElement(UnsentRecordings, {
      recordings: [recording("a", 60_000, at(23, 10, 12)), recording("b", 60_000, at(23, 9, 0))],
      onSend: () => {},
    }),
  );
  assert.match(two, /De finns kvar på den här enheten tills de har skickats\./);
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
  const rows = html.split("<li ").slice(1);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const summaryId = /<div id="([^"]+)"/.exec(row)?.[1];
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

test("an interrupted recording can be continued from the flow page's list", () => {
  const interrupted = { ...recording("a", 60_000, at(23, 10, 12)), state: "paused" as const };
  const finished = recording("b", 60_000, at(23, 9, 0));
  const labels = (html: string) => [...html.matchAll(/<button[^>]*>([^<]+)</g)].map(([, label]) => label);
  const html = renderToStaticMarkup(
    createElement(UnsentRecordings, { recordings: [interrupted, finished], onSend: () => {}, onContinue: () => {} }),
  );
  const [first, second] = html.split("<li ").slice(1);
  assert.deepEqual(labels(first), ["Fortsätt spela in", "Skicka", "Spara som fil", "Ta bort"]);
  assert.deepEqual(labels(second), ["Skicka", "Spara som fil", "Ta bort"]);
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(UnsentRecordings, { recordings: [interrupted], onSend: () => {} })),
    /Fortsätt spela in/,
    "the flow list has no recorder to continue in",
  );
});

test("without Web Locks, another tab's recording is offered only as a file to save, and says why", () => {
  const labels = (html: string) => [...html.matchAll(/<button[^>]*>([^<]+)</g)].map(([, label]) => label);
  const elsewhere = { ...recording("a", 60_000, at(23, 10, 12)), state: "paused" as const, exportOnly: true };
  const html = renderToStaticMarkup(
    createElement(UnsentRecordings, { recordings: [elsewhere, recording("b", 60_000, at(23, 9, 0))], onSend: () => {}, onContinue: () => {} }),
  );
  const [first, second] = html.split("<li ").slice(1);
  assert.deepEqual(labels(first), ["Spara som fil"]);
  assert.match(first, /I den här webbläsaren kan den bara sparas som fil\./);
  assert.deepEqual(labels(second), ["Skicka", "Spara som fil", "Ta bort"], "a recording this tab may change keeps every action");
});
