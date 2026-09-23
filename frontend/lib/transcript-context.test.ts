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
function stubEneo(t: { after: (fn: () => void) => void }, pages: Record<number, unknown> = {}, files: Record<string, string> = {}) {
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
    const artifact = /\/artifacts\/([^/]+)\/content$/.exec(address.pathname);
    if (artifact) {
      const content = files[artifact[1]];
      return content === undefined ? json({ detail: "fel" }, 404) : new Response(content, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
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

/** The real transcription step with its input, output and mode changed as a test needs. */
function variant(change: (step: Record<string, any>) => void): FlowRunStep[] {
  const step = structuredClone(realSteps[0]) as unknown as Record<string, any>;
  change(step);
  return [step as FlowRunStep];
}

const TRANSCRIPT = (realSteps[0].input_payload_json as { runtime_input: { text: string } }).runtime_input.text;
const bytes = (text: string) => new TextEncoder().encode(text).length;

test("a step that transcribed and then summarised shows the transcript it read, never its summary", async (t) => {
  stubEneo(t);
  const summarised = variant((step) => {
    step.model_parameters_json = { model_name: "gpt-5.6-luna" };
    step.output_payload_json = { text: "### 0:00 - 0:24\n\nSammanfattning: nämnden höjde budgetramen." };
  });
  const ctx = await loadTranscriptContext({ flowId: FLOW, runId: RUN, steps: summarised });
  assert.match(ctx.segments.map((s) => s.text).join(" "), /^Välkomna till nämndens möte/);
  assert.doesNotMatch(ctx.segments.map((s) => s.text).join(" "), /Sammanfattning/);

  const noInput = variant((step) => {
    delete step.input_payload_json.runtime_input;
    step.model_parameters_json = { model_name: "gpt-5.6-luna" };
    step.output_payload_json = { text: "### 0:00 - 0:24\n\nSammanfattning: nämnden höjde budgetramen." };
  });
  const unproven = await loadTranscriptContext({ flowId: FLOW, runId: RUN, steps: noInput });
  assert.deepEqual(unproven.segments, [], "an output not proven to be the transcript is never shown as speech");
});

test("a transcript too long to keep inline is read in full, or shown as a preview that is not exported", async (t) => {
  const preview = TRANSCRIPT.slice(0, 60);
  const fileBacked = variant((step) => {
    step.input_payload_json.runtime_input.text = {
      kind: "file_backed_step_text",
      preview,
      file_id: "file-full-transcript",
      inline_text_bytes: bytes(preview),
      full_text_bytes: bytes(TRANSCRIPT),
    };
  });

  stubEneo(t, {}, { "file-full-transcript": TRANSCRIPT });
  const full = await loadTranscriptContext({ flowId: FLOW, runId: RUN, steps: fileBacked });
  assert.equal(full.textPreview, false);
  assert.match(full.segments[0].text, /Nämnden beslutar att skicka ärendet på remiss\.$/, "the whole text");
});

test("a long transcript whose full file cannot be read is marked as a preview", async (t) => {
  const preview = TRANSCRIPT.slice(0, 60);
  const fileBacked = variant((step) => {
    step.input_payload_json.runtime_input.text = {
      kind: "file_backed_step_text",
      preview,
      file_id: "file-full-transcript",
      inline_text_bytes: bytes(preview),
      full_text_bytes: bytes(TRANSCRIPT),
    };
  });
  stubEneo(t);
  const partial = await loadTranscriptContext({ flowId: FLOW, runId: RUN, steps: fileBacked });
  assert.equal(partial.textPreview, true);
  assert.equal(partial.segments.length, 1, "the preview stays readable");
});

test("several recordings in text without named parts offer no seeks that could land in the wrong one", async (t) => {
  stubEneo(t);
  const text = "### 0:00 - 0:24\n\nFörsta filen.\n\n### 5:00 - 5:30\n\nAndra filen efter tystnad.";
  const unnamed = variant((step) => {
    step.input_payload_json.runtime_input.text = text;
    step.input_payload_json.transcription.file_ids = ["file-a", "file-b"];
  });
  const ctx = await loadTranscriptContext({ flowId: FLOW, runId: RUN, steps: unnamed });
  assert.equal(ctx.segments.length, 2, "the text stays readable");
  assert.deepEqual(ctx.fileIds, [], "which file a block belongs to is unknown, so nothing seeks");

  const named = variant((step) => {
    step.input_payload_json.runtime_input.text = `## Del 1\n\n### 0:00 - 0:24\n\nEtt.\n\n## Del 2\n\n### 0:00 - 0:10\n\nTvå.`;
    step.input_payload_json.transcription.file_ids = ["file-a", "file-b"];
  });
  const parts = await loadTranscriptContext({ flowId: FLOW, runId: RUN, steps: named });
  assert.deepEqual(parts.segments.map((s) => s.fileIndex), [0, 1]);
  assert.deepEqual(parts.fileIds, ["file-a", "file-b"], "named parts seek into their own file");
});
