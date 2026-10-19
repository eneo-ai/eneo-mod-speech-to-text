import assert from "node:assert/strict";
import test, { afterEach, type TestContext } from "node:test";

import { cleanup, installDom, mount } from "./test-dom";
import { INITIAL_TRANSCRIPT, type TranscriptContext } from "./transcript-context";
import { occurrencesForLine, withLineCorrection, withSpeakerDecision, type CorrectionSet } from "./transcript-corrections";
import type { TranscriptSegment } from "./transcript";

installDom();
afterEach(cleanup);

const segments: TranscriptSegment[] = [
  { fileIndex: 0, start: 0, end: 2, speaker: "SPEAKER_00", text: "Välkomna till mötet." },
  { fileIndex: 0, start: 2, end: 4, speaker: "SPEAKER_01", text: "Första punkten gäller budgeten." },
];
/** A finished run's transcript as the page reads it, nothing corrected yet. */
const transcript: TranscriptContext = {
  ...INITIAL_TRANSCRIPT,
  pending: false,
  segments,
  fromMetadata: true,
  stepId: "step-1",
  corrections: { occurrences: [], speaker_edits: [], revision: null, schemaVersion: 3, segmentsHash: "a".repeat(64) },
};

// Corrections a person makes: the first passage moved to Talare 2, a word put into the second, and its first word split
// off to a speaker of its own (undone with no decision there).
const moved = (set: CorrectionSet) => withSpeakerDecision(set, segments, 0, null, null, "confirmed", "SPEAKER_01");
const corrected = (set: CorrectionSet) => withLineCorrection(set, 1, occurrencesForLine(1, segments[1].text, "Första punkten gäller hela budgeten."));
const split = (set: CorrectionSet) => withSpeakerDecision(set, segments, 1, 0, 6, "confirmed", "SPEAKER_05");
const unsplit = (set: CorrectionSet) => withSpeakerDecision(set, segments, 1, 0, 6, null, null);

/** Eneo's answer to a save it took: the set as sent, one revision on. */
const taken = (body: Record<string, unknown>) =>
  Response.json({ ...body, flow_run_id: "run-1", step_id: "step-1", revision: Number(body.expected_revision ?? 0) + 1, stale: false, updated_at: "2026-09-24T10:00:00Z" });
const unreachable = () => Response.json({ code: "upstream_unreachable" }, { status: 502 });

/**
 * The page's corrections, saved to an Eneo that answers each request when the test says: the requests as sent, and the
 * most that were under way at once. `editing()` is the hook as the latest draw has it.
 */
async function correcting(t: TestContext) {
  const { createElement } = await import("react");
  const { useTranscriptCorrections } = await import("../components/useTranscriptCorrections");
  const original = globalThis.fetch;
  t.after(() => void (globalThis.fetch = original));
  const requests: { body: Record<string, unknown>; answer: (response: Response) => void }[] = [];
  let open = 0;
  let most = 0;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    most = Math.max(most, ++open);
    return new Promise<Response>((resolve) => {
      requests.push({ body: JSON.parse(String(init?.body)), answer: (response) => (open--, resolve(response)) });
    });
  }) as typeof fetch;
  let editing!: ReturnType<typeof useTranscriptCorrections>;
  function Probe() {
    editing = useTranscriptCorrections("flow-1", "run-1", transcript, () => undefined);
    return null;
  }
  const view = await mount(createElement(Probe));
  /** What a save sets going runs on: its request goes out, or an answer is read and the next save starts. */
  const settle = () => view.act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  /** Eneo answers request `index` (takes it, by default). */
  const answer = async (index: number, response: (body: Record<string, unknown>) => Response = taken) => {
    requests[index].answer(response(requests[index].body));
    await settle();
  };
  return { view, requests, most: () => most, settle, answer, editing: () => editing };
}

test("Spara namnen during a save waits for it, and a correction made meanwhile waits for the names: one request at a time", async (t) => {
  const { view, requests, most, settle, answer, editing } = await correcting(t);
  await view.act(async () => void editing().onCorrectionsChange(moved(editing().corrections)));
  let named!: Promise<string | null>;
  await view.act(async () => void (named = editing().saveNow({ SPEAKER_00: "Anna Berg" })));
  await view.act(async () => void editing().onCorrectionsChange(corrected(editing().corrections)));
  await settle();
  assert.equal(requests.length, 1, "the names and the correction wait for the save under way");
  await answer(0);
  assert.equal(requests.length, 2, "then the names go, alone");
  await answer(1);
  assert.equal(await named, null, "Spara namnen answers with its own save");
  assert.equal(requests.length, 3, "then the correction");
  await answer(2);
  assert.equal(most(), 1, "never two saves under way");
  assert.deepEqual(requests.map(({ body }) => body.expected_revision), [null, 1, 2], "each after the revision the one before it made");
  assert.deepEqual(requests.map(({ body }) => body.speaker_names), [{}, { SPEAKER_00: "Anna Berg" }, { SPEAKER_00: "Anna Berg" }], "the correction keeps the names");
  assert.equal(editing().saveState, "saved");
});

test("Spara namnen lays the names on the corrections as they are, also a correction the page has not drawn yet", async (t) => {
  const { view, requests, answer, editing } = await correcting(t);
  // One draw's hook: the passage is moved and the names saved before the page draws again.
  await view.act(async () => {
    const { onCorrectionsChange, saveNow, corrections } = editing();
    void onCorrectionsChange(moved(corrections));
    void saveNow({ SPEAKER_00: "Anna Berg" });
  });
  await answer(0);
  await answer(1);
  assert.deepEqual(requests[1].body.speaker_edits, requests[0].body.speaker_edits, "the move is kept");
  assert.deepEqual(requests[1].body.speaker_names, { SPEAKER_00: "Anna Berg" });
  assert.deepEqual(editing().corrections.speaker_edits, moved(transcript.corrections).speaker_edits, "and shown");
});

test("Spara namnen behind a save that fails is still sent, after it, and answers with its own outcome", async (t) => {
  const { view, requests, most, answer, editing } = await correcting(t);
  await view.act(async () => void editing().onCorrectionsChange(moved(editing().corrections)));
  let named!: Promise<string | null>;
  await view.act(async () => void (named = editing().saveNow({ SPEAKER_00: "Anna Berg" })));
  await answer(0, unreachable);
  assert.equal(requests.length, 2, "the names go although the save before them failed");
  await answer(1, unreachable);
  assert.equal(await named, "Eneo gick inte att nå just nu. Försök igen om en stund.", "their own refusal");
  await view.act(async () => void (named = editing().saveNow({ SPEAKER_00: "Anna Berg" })));
  await answer(2);
  assert.equal(await named, null, "Spara namnen again sends them again, and Eneo has them");
  assert.equal(most(), 1);
  assert.deepEqual(requests[2].body.speaker_edits, requests[0].body.speaker_edits, "with the move");
  assert.equal(editing().saveState, "saved");
});

test("a name for a speaker a split made goes when the split is undone, and the split made again is not named by it", async (t) => {
  const { view, requests, answer, editing } = await correcting(t);
  await view.act(async () => void editing().onCorrectionsChange(split(editing().corrections)));
  await answer(0);
  await view.act(async () => void editing().saveNow({ SPEAKER_05: "Anna Berg" }));
  await answer(1);
  await view.act(async () => void editing().onCorrectionsChange(unsplit(editing().corrections)));
  await answer(2);
  assert.deepEqual(editing().corrections.speakerNames, {}, "the page keeps no name for a speaker that is gone");
  await view.act(async () => void editing().onCorrectionsChange(split(editing().corrections)));
  await answer(3);
  assert.deepEqual(requests.map(({ body }) => body.speaker_names), [{}, { SPEAKER_05: "Anna Berg" }, {}, {}], "nor sends one with the split made again");
});

test("a save's answer gives the page the names as Eneo keeps them, never over a newer change", async (t) => {
  const { view, answer, editing } = await correcting(t);
  // Eneo keeps a name trimmed and an emptied one as none.
  await view.act(async () => void editing().saveNow({ SPEAKER_00: " Anna Berg ", SPEAKER_01: "" }));
  await answer(0, (body) => taken({ ...body, speaker_names: { SPEAKER_00: "Anna Berg", SPEAKER_01: null } }));
  assert.deepEqual(editing().corrections.speakerNames, { SPEAKER_00: "Anna Berg", SPEAKER_01: null });
  // A correction made while names are saved: their answer leaves it, and the names it was made with, as they are.
  await view.act(async () => void editing().saveNow({ SPEAKER_00: " Erik Lund " }));
  const shown = editing().corrections.speakerNames;
  await view.act(async () => void editing().onCorrectionsChange(corrected(editing().corrections)));
  await answer(1, (body) => taken({ ...body, speaker_names: { SPEAKER_00: "Erik Lund" } }));
  assert.deepEqual(editing().corrections.speakerNames, { SPEAKER_00: " Erik Lund " }, "the newer change's names");
  assert.equal(editing().corrections.occurrences.length, 1, "and its correction");
  await answer(2);
  // Names a correction keeps, and an answer gives back as sent, stay the same object: no passage is drawn again for them.
  assert.equal(editing().corrections.speakerNames, shown);
});
