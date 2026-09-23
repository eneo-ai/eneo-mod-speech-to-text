import assert from "node:assert/strict";
import test from "node:test";

import fixture from "../tests/fixtures/run_steps_without_segments.json";
import type { FlowRunStep } from "./api";
import { finishedRun } from "./run-progress";
import { loadTranscriptContext } from "./transcript-context";

const FLOW = "5c9d1a27-836a-4a37-a8b6-9180e5eb9aae";
const RUN = "13fc3e4f-5182-44ea-996b-4c08a2f16c42";
const STEP = "5d5dc851-8aec-4c81-8cab-cebdbdbb4a92";
const HASH = "a".repeat(64);
const realSteps = fixture.steps as unknown as FlowRunStep[];

/** Eneo behind the module's proxy: `pages` answers the transcript source by start index; the rest is quiet. */
function stubEneo(t: { after: (fn: () => void) => void }, pages: Record<number, unknown> = {}) {
  const original = globalThis.fetch;
  const urls: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (url: string | URL | Request) => {
    const address = new URL(String(url), "http://module.test");
    urls.push(address.pathname + address.search);
    if (address.pathname.endsWith("/transcript-source/")) {
      const page = pages[Number(address.searchParams.get("start_segment_index"))];
      return page ? json(page) : json({ detail: "fel" }, 500);
    }
    if (address.pathname.endsWith("/transcript-corrections/")) return json([]);
    return json({ detail: "Not found" }, 404);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return urls;
}

test("a real transcription without segments reaches the result page: its text, in its time block", async (t) => {
  const urls = stubEneo(t);
  assert.equal(finishedRun(null, { status: "completed" }, realSteps).transcribed, true, "the page shows a transcript");

  const ctx = await loadTranscriptContext({ flowId: FLOW, runId: RUN, steps: realSteps });

  assert.equal(ctx.correctionProblem, null);
  assert.equal(ctx.stepId, STEP);
  assert.deepEqual(ctx.fileIds, ["606abea0-e4fe-4e2a-9d33-0a6a03928cdc"], "the recording to play along");
  assert.deepEqual(
    ctx.segments.map((segment) => [segment.fileIndex, segment.start, segment.end]),
    [[0, 0, 24]],
    "Eneo's '### 0:00 - 0:24' block",
  );
  assert.match(ctx.segments[0].text, /^Välkomna till nämndens möte den 23 september\. Närvarande är ordföranden/);
  assert.equal(ctx.fromMetadata, false, "no stored segments to correct against");
  assert.deepEqual(urls.filter((url) => url.includes("transcript-source")), [], "Eneo said it has no segments");
});

test("segments come from Eneo's transcript source, page by page, with its hash for corrections", async (t) => {
  const step = structuredClone(realSteps[0]);
  const transcription = (step.input_payload_json as { transcription: { source: { bounds: Record<string, unknown> } } })
    .transcription;
  Object.assign(transcription.source.bounds, { segments_count: 3, segments_omitted_reason: null });
  const segment = (index: number, text: string, speaker: string) => ({
    segment_index: index,
    file_index: 0,
    start: index * 2,
    end: index * 2 + 2,
    speaker,
    text,
  });
  const urls = stubEneo(t, {
    0: {
      status: "present",
      source_hash: HASH,
      next_segment_index: 2,
      segments: [segment(0, "Välkomna.", "SPEAKER_00"), segment(1, "Tack.", "SPEAKER_01")],
      speaker_review: null,
    },
    2: { status: "present", source_hash: HASH, next_segment_index: null, segments: [segment(2, "Punkt ett.", "SPEAKER_00")] },
  });

  const ctx = await loadTranscriptContext({ flowId: FLOW, runId: RUN, steps: [step] });

  assert.deepEqual(ctx.segments.map((s) => [s.text, s.speaker]), [
    ["Välkomna.", "SPEAKER_00"],
    ["Tack.", "SPEAKER_01"],
    ["Punkt ett.", "SPEAKER_00"],
  ]);
  assert.equal(ctx.fromMetadata, true);
  assert.deepEqual([ctx.corrections.schemaVersion, ctx.corrections.segmentsHash], [3, HASH], "corrections carry the source hash");
  assert.deepEqual(
    urls.filter((url) => url.includes("transcript-source")),
    [0, 2].map((start) => `/api/eneo/flows/${FLOW}/runs/${RUN}/steps/${STEP}/attempts/1/transcript-source/?start_segment_index=${start}`),
  );
});

test("a transcript source that cannot be read shows the text and says so", async (t) => {
  const step = structuredClone(realSteps[0]);
  const transcription = (step.input_payload_json as { transcription: { source: { bounds: Record<string, unknown> } } })
    .transcription;
  Object.assign(transcription.source.bounds, { segments_count: 3, segments_omitted_reason: null });
  stubEneo(t);

  const ctx = await loadTranscriptContext({ flowId: FLOW, runId: RUN, steps: [step] });

  assert.match(ctx.correctionProblem ?? "", /^Kunde inte läsa transkriptets underlag/, "so its exports stay off (F1)");
  assert.equal(ctx.segments.length, 1, "the step's own text is still there to read");
});
