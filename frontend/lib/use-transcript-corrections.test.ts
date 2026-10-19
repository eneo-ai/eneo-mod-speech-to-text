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
/** The corrections as someone else saved them since the page read them: a word in the first passage, revision 4. */
const theirs: CorrectionSet = { ...withLineCorrection(transcript.corrections, 0, occurrencesForLine(0, segments[0].text, "Välkomna alla till mötet.")), revision: 4 };

/** Eneo's answer to a save it took: the set as sent, one revision on. */
const taken = (body: Record<string, unknown>) =>
  Response.json({ ...body, flow_run_id: "run-1", step_id: "step-1", revision: Number(body.expected_revision ?? 0) + 1, stale: false, updated_at: "2026-09-24T10:00:00Z" });
const unreachable = () => Response.json({ code: "upstream_unreachable" }, { status: 502 });
/** Eneo's refusal of a save made on a revision someone else has saved over. */
const stale = () => Response.json({ code: "flow_transcript_corrections_stale_revision" }, { status: 409 });
const READ_AGAIN = "Transkriberingen har lästs in igen, så ändringen sparades inte. Den senaste versionen visas nu. Gör om ändringen där.";

/** Whether leaving now would ask the browser's own question. */
const asksBeforeLeaving = () => {
  const event = new window.Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

/**
 * The page's corrections, saved to an Eneo that answers each request when the test says: the requests as sent, and the
 * most that were under way at once. `editing()` is the hook as the latest draw has it. The transcript is read again as
 * useTranscriptContext reads it: the hook's `reload` puts a read under way (`reloads()` counts them), and `landed` is its
 * answer.
 */
async function correcting(t: TestContext) {
  const { createElement, useState } = await import("react");
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
  let land!: (read: TranscriptContext) => void;
  let reloads = 0;
  function Probe() {
    const [read, setRead] = useState(transcript);
    land = setRead;
    editing = useTranscriptCorrections("flow-1", "run-1", read, () => {
      reloads++;
      setRead(INITIAL_TRANSCRIPT);
    });
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
  /** The read under way lands: Eneo has `corrections`. */
  const landed = (corrections: CorrectionSet) => view.act(async () => land({ ...transcript, corrections }));
  /** The person reads the transcript again (Läs in igen), and Eneo has `corrections`: asked for, then read. */
  const reread = async (corrections: CorrectionSet) => {
    await view.act(async () => editing.readAgain());
    await landed(corrections);
  };
  /** What the page offers the person to take with them (`downloadDropped`), as the file they get. */
  const takeDropped = async () => {
    const download = await import("./download");
    const files: Blob[] = [];
    t.mock.method(download, "downloadBlob", (blob: Blob) => void files.push(blob));
    await view.act(async () => editing.downloadDropped());
    return JSON.parse(await files[0].text()) as CorrectionSet;
  };
  return { view, requests, most: () => most, reloads: () => reloads, settle, answer, landed, reread, takeDropped, editing: () => editing };
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

test("a correction made after the transcript is read again waits for the save sent before it: one request at a time", async (t) => {
  const { view, requests, most, settle, answer, reread, editing } = await correcting(t);
  await view.act(async () => void editing().onCorrectionsChange(moved(editing().corrections)));
  await reread(theirs);
  await view.act(async () => void editing().onCorrectionsChange(corrected(editing().corrections)));
  await settle();
  assert.equal(requests.length, 1, "the correction waits for the save under way");
  await answer(0);
  assert.equal(requests.length, 2, "then it goes");
  await answer(1);
  assert.equal(most(), 1, "never two saves under way");
});

test("a save's answer that comes after the transcript is read again leaves the page as read: its revision, its corrections, its state", async (t) => {
  const { view, requests, settle, answer, reread, editing } = await correcting(t);
  await view.act(async () => void editing().onCorrectionsChange(moved(editing().corrections)));
  await reread(theirs);
  await answer(0);
  assert.equal(editing().corrections, theirs, "the corrections read");
  assert.equal(editing().saveState, "idle");
  assert.equal(editing().localError, null);
  assert.equal(editing().hasDropped, false, "Eneo has the move: nothing is kept as lost");
  await view.act(async () => void editing().onCorrectionsChange(corrected(editing().corrections)));
  await settle();
  assert.equal(requests[1].body.expected_revision, 4, "the next save is made on the revision read, and Eneo decides");
});

test("a save that fails after the transcript is read again holds back nothing made since, and its correction is kept to take", async (t) => {
  const { view, requests, answer, reread, editing } = await correcting(t);
  await view.act(async () => void editing().onCorrectionsChange(moved(editing().corrections)));
  await reread(theirs);
  await view.act(async () => void editing().onCorrectionsChange(corrected(editing().corrections)));
  await answer(0, unreachable);
  assert.equal(requests.length, 2, "the correction made since goes");
  assert.equal(editing().saveState, "saving", "the page says what it is doing");
  assert.equal(editing().localError, READ_AGAIN, "and that the move, gone with the read, was not saved");
  assert.equal(editing().hasDropped, true, "the move, to take with them");
  await answer(1);
  assert.equal(requests[1].body.expected_revision, 4);
  assert.equal(editing().saveState, "saved");
});

test("a save still waiting when the transcript is read again is not sent: it was made on what the page no longer shows", async (t) => {
  const { view, requests, settle, answer, reread, editing } = await correcting(t);
  await view.act(async () => void editing().onCorrectionsChange(moved(editing().corrections)));
  let named!: Promise<string | null>;
  await view.act(async () => void (named = editing().saveNow({ SPEAKER_00: "Anna Berg" })));
  await reread(theirs);
  await answer(0);
  await settle();
  assert.equal(requests.length, 1, "the names are not sent over the corrections read");
  assert.equal(await named, READ_AGAIN, "Spara namnen says why, so the naming stays open");
  // Named again, on what the page read: saved.
  await view.act(async () => void (named = editing().saveNow({ SPEAKER_00: "Anna Berg" })));
  await answer(1);
  assert.equal(await named, null);
  assert.equal(requests[1].body.expected_revision, 4);
  assert.deepEqual(requests[1].body.speaker_edits, [], "the passage moved before is not in it");
  assert.equal((requests[1].body.occurrences as unknown[]).length, 1, "their correction is");
});

test("a correction still waiting when the person reads the transcript again is not sent, and is kept for them to take, with why", async (t) => {
  const { view, requests, settle, answer, reread, takeDropped, editing } = await correcting(t);
  await view.act(async () => void editing().onCorrectionsChange(moved(editing().corrections)));
  await view.act(async () => void editing().onCorrectionsChange(corrected(editing().corrections)));
  await reread(theirs);
  await answer(0);
  await settle();
  assert.equal(requests.length, 1, "the correction is not sent over the corrections read");
  assert.equal(editing().corrections, theirs, "the page shows the read");
  assert.equal(editing().localError, READ_AGAIN, "and says the correction was not saved");
  assert.equal(asksBeforeLeaving(), true, "closing the page asks first: the correction is nowhere else");
  const kept = await takeDropped();
  assert.equal(kept.occurrences.length, 1, "the correction, to take with them");
  assert.deepEqual(kept.speaker_edits, moved(transcript.corrections).speaker_edits, "with the move made before it");
});

test("a save refused as stale reads again at once, and once: Spara namnen waiting behind it is not sent on the revision Eneo refused", async (t) => {
  const { view, requests, settle, answer, landed, reloads, takeDropped, editing } = await correcting(t);
  await view.act(async () => void editing().onCorrectionsChange(moved(editing().corrections)));
  let named!: Promise<string | null>;
  await view.act(async () => void (named = editing().saveNow({ SPEAKER_00: "Anna Berg" })));
  await answer(0, stale);
  assert.equal(requests.length, 1, "the names are not sent while the transcript is read again");
  assert.equal(await named, READ_AGAIN, "Spara namnen says why, so the naming stays open");
  await landed(theirs);
  await settle();
  assert.equal(reloads(), 1, "the transcript is read once");
  assert.equal(requests.length, 1);
  assert.equal(editing().corrections, theirs);
  assert.match(editing().localError ?? "", /ändrats av någon annan/, "the page says why its corrections were replaced");
  const kept = await takeDropped();
  assert.deepEqual(kept.speakerNames, { SPEAKER_00: "Anna Berg" }, "the names, the newest the person made, to take with them");
  assert.deepEqual(kept.speaker_edits, moved(transcript.corrections).speaker_edits, "with the move");
});

test("Spara namnen with the names a save under way sends answers, once it lands, that Eneo has them, though the page read again meanwhile", async (t) => {
  const { view, requests, answer, reread, editing } = await correcting(t);
  await view.act(async () => void editing().saveNow({ SPEAKER_00: "Anna Berg" }));
  let again!: Promise<string | null>;
  await view.act(async () => void (again = editing().saveNow({ SPEAKER_00: "Anna Berg" })));
  await reread(theirs);
  await answer(0);
  assert.equal(await again, null, "the names are with Eneo: the naming closes");
  assert.equal(requests.length, 1, "and nothing more is sent");
  assert.equal(editing().localError, null, "nothing is said to be lost");
  assert.equal(editing().hasDropped, false);
});
