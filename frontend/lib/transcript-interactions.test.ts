import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { computeAccessibleName } from "dom-accessibility-api";
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
// The count is the paragraph that says it: the design system's buttons hold live regions of their own.
const status = (within: ParentNode) => within.querySelector('p[role="status"]')?.textContent ?? "";
const chip = (within: ParentNode, words: string) =>
  [...within.querySelectorAll<HTMLButtonElement>('[aria-label="Visa talare"] button')].find((b) => b.textContent?.includes(words))!;
const searchField = (within: ParentNode) =>
  [...within.querySelectorAll<HTMLInputElement>("input")].find((input) => computeAccessibleName(input) === "Sök i transkriberingen")!;
// "Ändra talare" is a popover of the top layer; its choices are radios, named by their words.
const picker = () => document.querySelector("[data-popover-open]");
const radios = (within = "[data-popover-open]") => [...document.querySelectorAll<HTMLInputElement>(`${within} input[type="radio"]`)];
const radio = (name: string) => radios().find((input) => computeAccessibleName(input) === name)!;
const pick = (value: string) => radios().find((input) => input.value === value)!;
// The speakers to choose from are the picker's first group of radios; the scope ("Gäller") is the second.
const speakerRadios = () => [...(document.querySelector('[data-popover-open] [role="radiogroup"]')?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? [])];

test("search counts the hits, marks them, and steps through them with buttons and Enter", async () => {
  const view = await player(meeting);
  const field = searchField(view.container);
  assert.equal(status(view.container), "", "no count before there is something to look for");
  await view.act(async () => type(field, "punkten"));
  assert.equal(status(view.container), "Träff 1 av 3");
  assert.equal(view.container.querySelectorAll("mark[data-hit]").length, 3);
  const current = () => view.container.querySelector('mark[data-hit="current"]')?.closest("[data-segment-index]")?.getAttribute("data-segment-index");
  assert.equal(current(), "1");

  await view.act(async () => button(view.container, "Nästa träff")!.click());
  assert.equal(status(view.container), "Träff 2 av 3");
  assert.equal(current(), "2");
  await view.act(async () => button(view.container, "Föregående träff")!.click());
  await view.act(async () => button(view.container, "Föregående träff")!.click());
  assert.equal(status(view.container), "Träff 3 av 3", "stepping back from the first wraps to the last");
  await view.act(async () => field.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  assert.equal(status(view.container), "Träff 1 av 3", "Enter goes on to the next");

  await view.act(async () => type(field, "ingenting sådant"));
  assert.equal(status(view.container), "Inga träffar");
  assert.equal(button(view.container, "Nästa träff")!.disabled, true);
});

test("the speaker row filters and does nothing else; the search follows the filter", async () => {
  const view = await player(meeting);
  assert.equal(computeAccessibleName(chip(view.container, "Talare 1")), "Talare 1", "named by the name, no count");
  assert.ok(chip(view.container, "Talare 1").querySelector("[data-speaker-color]"), "with the speaker's mark");
  await view.act(async () => chip(view.container, "Talare 2").click());
  assert.deepEqual(passages(view.container), ["Talare 2, 0:02", "Talare 2, 0:06"]);
  assert.ok(!picker(), "a chip opens nothing");

  const field = searchField(view.container);
  await view.act(async () => type(field, "punkt"));
  assert.equal(status(view.container), "Träff 1 av 2", "only the passages shown are searched");

  await view.act(async () => chip(view.container, "Alla").click());
  assert.equal(passages(view.container).length, 4);
  assert.equal(status(view.container), "Träff 1 av 4");
});

test("by default Ändra talare moves the one passage", async () => {
  const saved: CorrectionSet[] = [];
  const view = await player(meeting, { editable: true, corrections: EMPTY, onCorrectionsChange: (next: CorrectionSet) => saved.push(next) });
  await view.act(async () => button(view.container, "Talare 1, ändra talare")!.click());
  assert.equal(radio("Bara det här inlägget").checked, true, "this passage alone unless widened");
  await view.act(async () => pick("SPEAKER_01").click());
  await view.act(async () => button(document.body, "Spara")!.click());
  assert.deepEqual(saved[0].speaker_edits.map((e) => e.segment_index), [0]);
});

test("Alla N inlägg från … is chosen, and writes one whole-passage edit for each", async () => {
  const saved: CorrectionSet[] = [];
  const view = await player(meeting, { editable: true, corrections: EMPTY, onCorrectionsChange: (next: CorrectionSet) => saved.push(next) });
  await view.act(async () => button(view.container, "Talare 1, ändra talare")!.click());
  await view.act(async () => radio("Alla 2 inlägg från Talare 1").click());
  await view.act(async () => pick("SPEAKER_01").click());
  await view.act(async () => button(document.body, "Spara")!.click());

  assert.equal(saved.length, 1);
  assert.deepEqual(
    saved[0].speaker_edits.map((e) => [e.segment_index, e.char_start, e.original_speaker, e.speaker]),
    [[0, null, "SPEAKER_00", "SPEAKER_01"], [2, null, "SPEAKER_00", "SPEAKER_01"]],
  );
});

const toCheck: TranscriptSegment[] = meeting.map((segment, i) =>
  i === 1 ? { ...segment, modelSpeaker: "SPEAKER_01", speakerAttribution: "provisional", overlapIds: ["overlap_0001"] } : segment,
);
const v3: CorrectionSet = { schemaVersion: 3, segmentsHash: "a".repeat(64), occurrences: [], speaker_edits: [], revision: 1 };

test("an uncertain passage keeps Eneo's words in the name slot, and one action: Ändra talare", async () => {
  const saved: CorrectionSet[] = [];
  const view = await player(toCheck, { editable: true, corrections: v3, onCorrectionsChange: (next: CorrectionSet) => saved.push(next) });
  const item = view.container.querySelector('li[data-turn-index="1"]')!;
  const status = [...item.querySelectorAll("span")].find((el) => el.textContent === "Överlappande tal – osäker talare");
  assert.ok(status && !status.closest("button"), "the name slot says it, and is not a button");
  assert.doesNotMatch(item.textContent ?? "", /Kontrollera/);
  assert.deepEqual(
    [...item.querySelectorAll("button")].map((b) => b.textContent?.trim()).filter((t) => /talare/i.test(t ?? "")),
    ["Ändra talare"],
  );
  // The label names the uncertainty, never a suggested speaker as if settled.
  assert.equal(item.getAttribute("aria-label"), "Överlappande tal – osäker talare, 0:02");
  // An unnamed speaker is not uncertain: only the passage Eneo marked says so.
  assert.equal(view.container.querySelectorAll("li[data-turn-index]")[3].textContent?.includes("Osäker"), false);

  // The passages to check are a filter set apart from the speakers: after a divider, counted as a to-do.
  const toDo = chip(view.container, "Osäkra");
  assert.equal(computeAccessibleName(toDo), "Osäkra (1)");
  assert.equal(toDo.previousElementSibling?.getAttribute("data-orientation"), "vertical", "after a divider");
  await view.act(async () => toDo.click());
  assert.deepEqual(passages(view.container), ["Överlappande tal – osäker talare, 0:02"]);
  await view.act(async () => chip(view.container, "Alla").click());

  await view.act(async () => button(view.container, "Ändra talare")!.click());
  const options = speakerRadios().map((input) => computeAccessibleName(input));
  assert.equal(options[0], "Det stämmer: Talare 2", "first: the speaker Eneo put there is right");
  assert.equal(options[options.length - 1], "Går inte att avgöra", "last: it cannot be told");
  assert.equal(radio("Bara det här inlägget").checked, true);
  await view.act(async () => pick("SPEAKER_00").click());
  await view.act(async () => button(document.body, "Spara")!.click());
  assert.deepEqual(
    saved[0].speaker_edits.map((e) => [e.segment_index, e.char_start, e.decision, e.speaker]),
    [[1, null, "confirmed", "SPEAKER_00"]],
  );
});

test("Det stämmer confirms the speaker, and Går inte att avgöra is a decision too", async () => {
  const confirmed: CorrectionSet[] = [];
  const first = await player(toCheck, { editable: true, corrections: v3, onCorrectionsChange: (next: CorrectionSet) => confirmed.push(next) });
  await first.act(async () => button(first.container, "Ändra talare")!.click());
  await first.act(async () => pick("SPEAKER_01").click());
  await first.act(async () => button(document.body, "Spara")!.click());
  assert.deepEqual(confirmed[0].speaker_edits.map((e) => [e.segment_index, e.decision, e.speaker]), [[1, "confirmed", "SPEAKER_01"]]);
  await first.unmount();

  const saved: CorrectionSet[] = [];
  const view = await player(toCheck, { editable: true, corrections: v3, onCorrectionsChange: (next: CorrectionSet) => saved.push(next) });
  await view.act(async () => button(view.container, "Ändra talare")!.click());
  await view.act(async () => pick("__unresolved").click());
  assert.equal(radios().find((input) => computeAccessibleName(input) === "Bara det här inlägget"), undefined, "no scope for a passage-only decision");
  await view.act(async () => button(document.body, "Spara")!.click());
  assert.deepEqual(saved[0].speaker_edits.map((e) => [e.segment_index, e.decision, e.speaker]), [[1, "unresolved", null]]);
});

test("without Eneo's newer correction format an uncertain passage offers no choice it could not save", async () => {
  const view = await player(toCheck, { editable: true, corrections: EMPTY, onCorrectionsChange: () => undefined });
  assert.ok(view.container.querySelector('li[data-turn-index="1"]')!.textContent?.includes("Överlappande tal – osäker talare"));
  assert.ok(!button(view.container, "Ändra talare"), "no Ändra talare");
});

test("a transcript without speakers reads as paragraphs: no speaker row, marks or names, search still there", async () => {
  const view = await player([
    { fileIndex: 0, start: 0, end: 24, speaker: null, text: "Välkomna till nämndens möte." },
    { fileIndex: 0, start: 24, end: 30, speaker: null, text: "Första punkten." },
  ]);
  assert.ok(!view.container.querySelector('[aria-label="Visa talare"]'), "no speaker row");
  assert.doesNotMatch(view.container.textContent ?? "", /Talare|Okänd/);
  assert.deepEqual(passages(view.container), ["0:00", "0:24"], "one paragraph per timed block");
  assert.ok(searchField(view.container));
});

test("Ändra talare on a passage Eneo gave no speaker changes nothing: nothing is sent, and the picker says why", async () => {
  const unknown: TranscriptSegment[] = [{ ...meeting[0], speaker: null }, ...meeting.slice(1)];
  const saved: CorrectionSet[] = [];
  const view = await player(unknown, { editable: true, corrections: EMPTY, onCorrectionsChange: (next: CorrectionSet) => saved.push(next) });
  await view.act(async () => button(view.container, "Okänd talare, ändra talare")!.click());
  await view.act(async () => pick("SPEAKER_01").click());
  await view.act(async () => button(document.body, "Spara")!.click());
  assert.equal(saved.length, 0, "nothing sent");
  assert.match(document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? "", /kan inte ändras/);
  assert.ok(button(document.body, "Spara"), "the picker stays open with the choice");
});

test("a bulk change past Eneo's cap on speaker edits is refused before anything is sent", async () => {
  // 1 001 passages each for two speakers, and 1 000 edits already saved: moving all of Talare 1 would make 2 001.
  const many: TranscriptSegment[] = Array.from({ length: 2002 }, (_, i) => ({
    fileIndex: 0, start: i, end: i + 1, speaker: i % 2 ? "SPEAKER_01" : "SPEAKER_00", text: `Mening ${i}.`,
  }));
  const saved: CorrectionSet[] = [];
  const existing: CorrectionSet = {
    ...EMPTY,
    speaker_edits: Array.from({ length: 1000 }, (_, k) => ({
      segment_index: 2 * k + 1, char_start: null, char_end: null, original: null, original_speaker: "SPEAKER_01", speaker: "SPEAKER_02",
    })),
  };
  const view = await player(many, {
    editable: true, corrections: existing, speakerOptions: ["SPEAKER_02"], onCorrectionsChange: (next: CorrectionSet) => saved.push(next),
  });
  await view.act(async () => button(view.container, "Talare 1, ändra talare")!.click());
  await view.act(async () => radio("Alla 1001 inlägg från Talare 1").click());
  await view.act(async () => pick("SPEAKER_02").click());
  await view.act(async () => button(document.body, "Spara")!.click());
  assert.equal(saved.length, 0, "nothing sent");
  assert.match(document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? "", /fler än 2 000 talarändringar/);
  assert.ok(button(document.body, "Spara"), "the picker stays open with the choice");
});

test("one Rätta per passage, after its text; in a passage of several sentences each sentence is then the target", async () => {
  const opened: string[] = [];
  const two: TranscriptSegment[] = [
    {
      fileIndex: 0, start: 0, end: 2, speaker: "SPEAKER_00", text: "Välkomna.",
      words: [{ word: "Välkomna.", start: 0, end: 1, probability: 0, charStart: 0, charEnd: 9, uncertain: true }],
    },
    { fileIndex: 0, start: 2, end: 4, speaker: "SPEAKER_00", text: "Vi har två punkter." },
    { fileIndex: 0, start: 4, end: 6, speaker: "SPEAKER_01", text: "Tack." },
  ];
  const view = await player(two, {
    editable: true, corrections: EMPTY, onCorrectionsChange: () => undefined,
    confirmedWords: new Set<string>(), onToggleConfirmed: () => undefined,
  });
  const rätta = [...view.container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Rätta");
  assert.equal(rätta.length, 2, "one per passage, not one per sentence");
  const sentences = () => [...view.container.querySelectorAll<HTMLElement>('[role="button"][data-segment-index]')];
  assert.equal(sentences().length, 0, "no sentence targets at rest");
  assert.equal(view.container.querySelectorAll('button[aria-label^="Bekräfta att"]').length, 1, "the uncertain word can be confirmed at rest");
  const first = rätta[0];
  assert.equal(first.getAttribute("aria-label"), "Rätta repliken från 0:00: välj mening");
  assert.ok(first.previousElementSibling?.textContent?.includes("Vi har två punkter."), "after the passage's last sentence");

  await view.act(async () => first.click());
  assert.ok(view.container.textContent?.includes("Välj meningen du vill rätta."), "a hint above the passage");
  // Each sentence is the target, named by its own words first (WCAG 2.5.3); no pencil beside it.
  const { computeAccessibleName } = await import("dom-accessibility-api");
  assert.deepEqual(sentences().map((s) => computeAccessibleName(s)), ["Välkomna. Rätta meningen från 0:00.", "Vi har två punkter. Rätta meningen från 0:02."]);
  assert.ok(sentences().every((s) => s.tabIndex === 0 && !s.querySelector("button, [role=button]")), "focusable, with no control inside it");
  assert.equal(view.container.querySelectorAll('button[aria-label^="Rätta meningen"], button[aria-label^="Bekräfta att"]').length, 0);
  assert.equal(first.textContent?.trim(), "Klar");
  assert.ok(first.querySelector(".lucide-check") && !first.querySelector(".lucide-pencil"), "Klar carries a check, not a pencil");

  const second = sentences()[1];
  await view.act(async () => second.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const editor = view.container.querySelector("textarea");
  opened.push(editor ? computeAccessibleName(editor) : "");
  assert.deepEqual(opened, ["Rätta repliken från 0:02"]);
});

test("two parts that both start at 0:00 name their passages' and sentences' corrections by the part", async () => {
  // The same words at the same time in both parts: only the part tells them apart for a screen reader.
  const part = (fileIndex: number): TranscriptSegment[] => [
    { fileIndex, start: 0, end: 2, speaker: "SPEAKER_00", text: "Välkomna." },
    { fileIndex, start: 2, end: 4, speaker: "SPEAKER_00", text: "Vi har två punkter." },
  ];
  const view = await player([...part(0), ...part(1)], { editable: true, corrections: EMPTY, onCorrectionsChange: () => undefined });
  const rätta = [...view.container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Rätta");
  assert.deepEqual(rätta.map((b) => b.getAttribute("aria-label")), ["Rätta repliken från 0:00 i del 1: välj mening", "Rätta repliken från 0:00 i del 2: välj mening"]);
  for (const button of rätta) await view.act(async () => button.click());
  const { computeAccessibleName } = await import("dom-accessibility-api");
  const sentences = [...view.container.querySelectorAll<HTMLElement>('[role="button"][data-segment-index]')];
  assert.deepEqual(sentences.map((s) => computeAccessibleName(s)), [
    "Välkomna. Rätta meningen från 0:00 i del 1.",
    "Vi har två punkter. Rätta meningen från 0:02 i del 1.",
    "Välkomna. Rätta meningen från 0:00 i del 2.",
    "Vi har två punkter. Rätta meningen från 0:02 i del 2.",
  ]);
});

test("a sentence corrected in its middle is named by the words it shows, unbroken, while choosing", async () => {
  const { computeAccessibleName } = await import("dom-accessibility-api");
  const text = "Budgeten höjs nästa år.";
  const corrected: CorrectionSet = {
    ...EMPTY,
    occurrences: [{ segment_index: 0, char_start: text.indexOf("höjs"), char_end: text.indexOf("höjs") + 4, original: "höjs", corrected: "sänks" }],
  };
  const passage: TranscriptSegment[] = [
    { fileIndex: 0, start: 0, end: 2, speaker: "SPEAKER_00", text },
    { fileIndex: 0, start: 2, end: 4, speaker: "SPEAKER_00", text: "Vi tar det i oktober." },
  ];
  const view = await player(passage, { editable: true, corrections: corrected, onCorrectionsChange: () => undefined });
  const rätta = [...view.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Rätta")!;
  await view.act(async () => rätta.click());
  const sentence = view.container.querySelector<HTMLElement>('[role="button"][data-segment-index="0"]')!;
  // What a sighted user reads: the rendered text without the visually hidden notes.
  const shown = (node: Node): string =>
    node.nodeType === 3 ? node.textContent ?? "" : (node as Element).hasAttribute?.("data-correction-note") ? "" : [...node.childNodes].map(shown).join("");
  assert.equal(shown(sentence), "Budgeten sänks nästa år.");
  // WCAG 2.5.3: the computed name holds the visible words together, the action after them; the note stays out.
  assert.equal(computeAccessibleName(sentence), "Budgeten sänks nästa år. Rätta meningen från 0:00.");
});

test("Bara det här inlägget on half of a split sentence moves that half only", async () => {
  // One sentence, its first half by Talare 1 and its second by Talare 2 (a span edit Eneo stores).
  const text = "Vi börjar nu. Jag tar över här.";
  const cut = text.indexOf("Jag");
  const split: CorrectionSet = {
    ...v3,
    speaker_edits: [{ segment_index: 0, char_start: cut, char_end: text.length, original: text.slice(cut), original_speaker: "SPEAKER_00", speaker: "SPEAKER_01", decision: "confirmed" }],
  };
  const saved: CorrectionSet[] = [];
  const view = await player(
    [{ fileIndex: 0, start: 0, end: 4, speaker: "SPEAKER_00", text }, { fileIndex: 0, start: 4, end: 6, speaker: "SPEAKER_02", text: "Tack." }],
    { editable: true, corrections: split, onCorrectionsChange: (next: CorrectionSet) => saved.push(next) },
  );
  await view.act(async () => button(view.container, "Talare 2, ändra talare")!.click());
  await view.act(async () => pick("SPEAKER_02").click());
  await view.act(async () => button(document.body, "Spara")!.click());
  const { applyCorrections } = await import("./transcript-corrections");
  const after = applyCorrections([{ fileIndex: 0, start: 0, end: 4, speaker: "SPEAKER_00", text }], saved[0]).segments;
  assert.deepEqual(after.map((s) => [s.text, s.speaker]), [["Vi börjar nu. ", "SPEAKER_00"], ["Jag tar över här.", "SPEAKER_02"]]);
});

test("each passage's count of its speaker's passages is not a scan of the whole transcript", async (t) => {
  // 400 passages: counting per passage by scanning all of them would ask about 160 000 times.
  const long: TranscriptSegment[] = Array.from({ length: 400 }, (_, i) => ({
    fileIndex: 0, start: i, end: i + 1, speaker: i % 2 ? "SPEAKER_01" : "SPEAKER_00", text: `Mening ${i}.`,
  }));
  const transcript = require("./transcript") as { pendingSpeakerReview: (turn: unknown) => boolean };
  const real = transcript.pendingSpeakerReview;
  let asked = 0;
  transcript.pendingSpeakerReview = (turn) => {
    asked++;
    return real(turn);
  };
  t.after(() => void (transcript.pendingSpeakerReview = real));
  await player(long, { editable: true, corrections: EMPTY, onCorrectionsChange: () => undefined });
  assert.ok(asked < 20 * long.length, `asked ${asked} times for ${long.length} passages`);
});

test("an approval that arrives while a passage is being corrected ends the correcting: the typed text stays only as a note, never saved", async () => {
  const { createElement, useState } = await import("react");
  const { TranscriptPlayer } = await import("../components/TranscriptPlayer");
  const saved: CorrectionSet[] = [];
  let approve!: () => void;
  function Review() {
    const [editable, setEditable] = useState(true);
    approve = () => setEditable(false);
    return createElement(TranscriptPlayer, {
      segments: meeting,
      fileCount: 0,
      audioSrcFor: () => "",
      speakerNames: {},
      textFallback: "",
      reviewEnabled: false,
      editable,
      corrections: EMPTY,
      onCorrectionsChange: (next: CorrectionSet) => saved.push(next),
    });
  }
  const view = await mount(createElement(Review));
  await view.act(async () => button(view.container, "Rätta repliken från 0:02")!.click());
  await view.act(async () => type(view.container.querySelector("textarea")!, "Första punkten gäller skolan."));

  await view.act(async () => approve());
  const note = view.container.querySelector("textarea")!;
  assert.ok(note.readOnly, "what was typed stays to copy, read-only");
  assert.equal(note.value, "Första punkten gäller skolan.");
  assert.match(view.container.textContent ?? "", /Rättningen kan inte sparas längre/);
  assert.equal(button(view.container, "Spara"), null, "nothing to save it with");
  await view.act(async () => note.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true })));
  await view.act(async () => button(view.container, "Stäng")!.click());
  assert.equal(view.container.querySelector("textarea"), null);
  assert.deepEqual(saved, [], "never applied");
  assert.equal(button(view.container, "Rätta repliken från 0:00"), null, "no correcting once approved");
  assert.equal(button(view.container, "Talare 1, ändra talare"), null, "nor changing a speaker");
});

test("more than five speakers: chips from a laptop's width, a list to pick one below it", async () => {
  const six: TranscriptSegment[] = Array.from({ length: 7 }, (_, i) => ({
    fileIndex: 0, start: i * 2, end: i * 2 + 2, speaker: `SPEAKER_0${i % 6}`, text: `Mening ${i}.`,
  }));
  const view = await player(six);
  assert.ok(view.container.querySelector("[data-many]"), "the chips know there are many, so a narrow screen hides them");
  const list = [...view.container.querySelectorAll<HTMLElement>("[role=combobox], button")].find((el) => computeAccessibleName(el) === "Filtrera talare");
  assert.ok(list, "a list to pick a speaker from");
  const few = await player(meeting);
  assert.equal(few.container.querySelector("[data-many]"), null, "with few speakers the chips are always shown");
  const none = [...few.container.querySelectorAll<HTMLElement>("[role=combobox], button")].find((el) => computeAccessibleName(el) === "Filtrera talare");
  assert.equal(none, undefined, "and there is no list");
});

test("a filter whose speaker has gone shows everyone again", async () => {
  const { createElement, useState } = await import("react");
  const { TranscriptPlayer } = await import("../components/TranscriptPlayer");
  let drop!: () => void;
  function Review() {
    const [segments, setSegments] = useState(meeting);
    drop = () => setSegments(meeting.filter((segment) => segment.speaker !== "SPEAKER_01"));
    return createElement(TranscriptPlayer, { segments, fileCount: 0, audioSrcFor: () => "", speakerNames: {}, textFallback: "", reviewEnabled: false });
  }
  const view = await mount(createElement(Review));
  await view.act(async () => chip(view.container, "Talare 2").click());
  assert.deepEqual(passages(view.container), ["Talare 2, 0:02", "Talare 2, 0:06"]);
  await view.act(async () => drop());
  // Their two passages are one now, with no one between them: Talare 2 has none left, so all are shown.
  assert.deepEqual(passages(view.container), ["Talare 1, 0:00"]);
  assert.equal(chip(view.container, "Alla").getAttribute("aria-pressed"), "true");
});

test("the clock on a passage plays from there, also while the recording is paused", async () => {
  const media = window.HTMLMediaElement.prototype;
  const { play, pause, load } = media;
  const played: string[] = [];
  media.play = function (this: HTMLMediaElement) {
    played.push(`${this.currentTime}`);
    return Promise.resolve();
  };
  media.pause = () => undefined;
  media.load = () => undefined;
  try {
    const view = await player(meeting, { fileCount: 1, audioSrcFor: () => "/audio/0" });
    await view.act(async () => button(view.container, "Spela från 0:02")!.click());
    // The audio has loaded: where the press asked to go, and whether to play on.
    await view.act(async () => view.container.querySelector("audio")!.dispatchEvent(new window.Event("loadedmetadata")));
    assert.deepEqual(played, ["2"], "the passage's own words promise it plays");
  } finally {
    media.play = play;
    media.pause = pause;
    media.load = load;
  }
});
