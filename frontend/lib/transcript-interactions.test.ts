import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { button, cleanup, installDom, mount, type } from "./test-dom";
import type { CorrectionSet } from "./transcript-corrections";
import type { TranscriptSegment } from "./transcript";

installDom();
afterEach(cleanup);

const meeting: TranscriptSegment[] = [
  { fileIndex: 0, start: 0, end: 2, speaker: "SPEAKER_00", text: "Välkomna. Vi har två punkter i dag." },
  { fileIndex: 0, start: 2, end: 4, speaker: "SPEAKER_01", text: "Första punkten gäller budgeten." },
  { fileIndex: 0, start: 4, end: 6, speaker: "SPEAKER_00", text: "Då godkänner vi den punkten." },
  { fileIndex: 0, start: 6, end: 8, speaker: "SPEAKER_01", text: "Andra punkten är skolskjutsarna." },
];

const EMPTY: CorrectionSet = { occurrences: [], speaker_edits: [], revision: null };

async function player(segments: TranscriptSegment[], props: Record<string, unknown> = {}) {
  const { createElement } = await import("react");
  const { TranscriptPlayer } = await import("../components/TranscriptPlayer");
  return mount(
    createElement(TranscriptPlayer, {
      segments,
      fileCount: 0,
      audioSrcFor: () => "",
      speakerNames: {},
      textFallback: "",
      reviewEnabled: false,
      ...props,
    }),
  );
}

const passages = (within: ParentNode) =>
  [...within.querySelectorAll<HTMLLIElement>("li[data-turn-index]")].map((li) => li.getAttribute("aria-label"));
const status = (within: ParentNode) => within.querySelector('[role="status"]')?.textContent ?? "";
const chip = (within: ParentNode, words: string) =>
  [...within.querySelectorAll<HTMLButtonElement>('[aria-label="Visa talare"] button')].find((b) => b.textContent?.includes(words))!;

test("search counts the hits, marks them, and steps through them with buttons and Enter", async () => {
  const view = await player(meeting);
  const field = view.container.querySelector<HTMLInputElement>('input[aria-label="Sök i transkriptet"]')!;
  await view.act(async () => type(field, "punkten"));
  assert.equal(status(view.container), "1 av 3 träffar");
  assert.equal(view.container.querySelectorAll("mark[data-hit]").length, 3);
  const current = () => view.container.querySelector('mark[data-hit="current"]')?.closest("[data-segment-index]")?.getAttribute("data-segment-index");
  assert.equal(current(), "1");

  await view.act(async () => button(view.container, "Nästa träff")!.click());
  assert.equal(status(view.container), "2 av 3 träffar");
  assert.equal(current(), "2");
  await view.act(async () => button(view.container, "Föregående träff")!.click());
  await view.act(async () => button(view.container, "Föregående träff")!.click());
  assert.equal(status(view.container), "3 av 3 träffar", "stepping back from the first wraps to the last");
  await view.act(async () => field.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  assert.equal(status(view.container), "1 av 3 träffar", "Enter goes on to the next");

  await view.act(async () => type(field, "ingenting sådant"));
  assert.equal(status(view.container), "Inga träffar");
  assert.equal(button(view.container, "Nästa träff")!.disabled, true);
  await view.unmount();
});

test("the speaker row is the legend and the filter; the search follows the filter", async () => {
  const view = await player(meeting);
  assert.match(chip(view.container, "Talare 1").textContent ?? "", /Talare 12$/, "mark, name and passages");
  await view.act(async () => chip(view.container, "Talare 2").click());
  assert.deepEqual(passages(view.container), ["Talare 2, 0:02", "Talare 2, 0:06"]);

  const field = view.container.querySelector<HTMLInputElement>('input[aria-label="Sök i transkriptet"]')!;
  await view.act(async () => type(field, "punkt"));
  assert.equal(status(view.container), "1 av 2 träffar", "only the passages shown are searched");

  await view.act(async () => chip(view.container, "Alla").click());
  assert.equal(passages(view.container).length, 4);
  assert.equal(status(view.container), "1 av 4 träffar");
  await view.unmount();
});

test("choosing the speaker for all of someone's passages writes one whole-passage edit for each", async () => {
  const saved: CorrectionSet[] = [];
  const view = await player(meeting, { editable: true, corrections: EMPTY, onCorrectionsChange: (next: CorrectionSet) => saved.push(next) });
  await view.act(async () => button(view.container, "Talare 1, byt talare")!.click());
  assert.ok(document.body.textContent?.includes("Vem talar här?"));
  assert.ok(button(document.body, "Alla 2 inlägg")!.getAttribute("data-state") === "on", "a settled passage changes with its speaker's others");
  await view.act(async () => document.querySelector<HTMLButtonElement>('button[role="radio"][value="SPEAKER_01"]')!.click());
  await view.act(async () => button(document.body, "Spara")!.click());

  assert.equal(saved.length, 1);
  assert.deepEqual(
    saved[0].speaker_edits.map((e) => [e.segment_index, e.char_start, e.original_speaker, e.speaker]),
    [[0, null, "SPEAKER_00", "SPEAKER_01"], [2, null, "SPEAKER_00", "SPEAKER_01"]],
  );
  await view.unmount();
});

test("Bara det här inlägget moves one passage", async () => {
  const saved: CorrectionSet[] = [];
  const view = await player(meeting, { editable: true, corrections: EMPTY, onCorrectionsChange: (next: CorrectionSet) => saved.push(next) });
  await view.act(async () => button(view.container, "Talare 1, byt talare")!.click());
  await view.act(async () => button(document.body, "Bara det här inlägget")!.click());
  await view.act(async () => document.querySelector<HTMLButtonElement>('button[role="radio"][value="SPEAKER_01"]')!.click());
  await view.act(async () => button(document.body, "Spara")!.click());
  assert.deepEqual(saved[0].speaker_edits.map((e) => e.segment_index), [0]);
  await view.unmount();
});

const toCheck: TranscriptSegment[] = meeting.map((segment, i) =>
  i === 1 ? { ...segment, modelSpeaker: "SPEAKER_01", speakerAttribution: "provisional", overlapIds: ["overlap_0001"] } : segment,
);
const v3: CorrectionSet = { schemaVersion: 3, segmentsHash: "a".repeat(64), occurrences: [], speaker_edits: [], revision: 1 };

test("a passage to check says so, can be reached from the speaker row, and takes a decision for itself", async () => {
  const saved: CorrectionSet[] = [];
  const view = await player(toCheck, { editable: true, corrections: v3, onCorrectionsChange: (next: CorrectionSet) => saved.push(next) });
  const item = view.container.querySelector('li[data-turn-index="1"]')!;
  assert.ok(item.textContent?.includes("Kontrollera talaren"));
  // The label names the uncertainty, never a suggested speaker as if settled.
  assert.equal(item.getAttribute("aria-label"), "Överlappande tal – osäker talare, 0:02");

  await view.act(async () => chip(view.container, "Kontrollera talaren").click());
  assert.deepEqual(passages(view.container), ["Överlappande tal – osäker talare, 0:02"]);

  await view.act(async () => button(view.container, "Välj talare")!.click());
  assert.equal(button(document.body, "Bara det här inlägget")!.getAttribute("data-state"), "on", "a passage to check changes alone by default");
  await view.act(async () => document.querySelector<HTMLButtonElement>('button[role="radio"][value="SPEAKER_00"]')!.click());
  await view.act(async () => button(document.body, "Spara")!.click());
  assert.deepEqual(
    saved[0].speaker_edits.map((e) => [e.segment_index, e.char_start, e.decision, e.speaker]),
    [[1, null, "confirmed", "SPEAKER_00"]],
  );
  await view.unmount();
});

test("Går inte att avgöra is a decision too", async () => {
  const saved: CorrectionSet[] = [];
  const view = await player(toCheck, { editable: true, corrections: v3, onCorrectionsChange: (next: CorrectionSet) => saved.push(next) });
  await view.act(async () => button(view.container, "Välj talare")!.click());
  await view.act(async () => document.querySelector<HTMLButtonElement>('button[role="radio"][value="__unresolved"]')!.click());
  assert.ok(!button(document.body, "Bara det här inlägget"), "no scope for a passage-only decision");
  await view.act(async () => button(document.body, "Spara")!.click());
  assert.deepEqual(saved[0].speaker_edits.map((e) => [e.segment_index, e.decision, e.speaker]), [[1, "unresolved", null]]);
  await view.unmount();
});

test("without Eneo's newer correction format a passage to check offers no choice it could not save", async () => {
  const view = await player(toCheck, { editable: true, corrections: EMPTY, onCorrectionsChange: () => undefined });
  assert.ok(view.container.querySelector('li[data-turn-index="1"]')!.textContent?.includes("Kontrollera talaren"));
  assert.ok(!button(view.container, "Välj talare"), "no Välj talare");
  await view.unmount();
});

test("a transcript without speakers reads as paragraphs: no speaker row, marks or names, search still there", async () => {
  const view = await player([
    { fileIndex: 0, start: 0, end: 24, speaker: null, text: "Välkomna till nämndens möte." },
    { fileIndex: 0, start: 24, end: 30, speaker: null, text: "Första punkten." },
  ]);
  assert.ok(!view.container.querySelector('[aria-label="Visa talare"]'), "no speaker row");
  assert.doesNotMatch(view.container.textContent ?? "", /Talare|Okänd/);
  assert.deepEqual(passages(view.container), ["0:00", "0:24"], "one paragraph per timed block");
  assert.ok(view.container.querySelector('input[aria-label="Sök i transkriptet"]'));
  await view.unmount();
});
