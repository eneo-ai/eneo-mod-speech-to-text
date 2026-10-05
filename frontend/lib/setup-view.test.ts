import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import sv from "@astryxdesign/core/locales/sv-SE.json";

import { ClassificationNote } from "../components/flow/ClassificationNote";
import { COUNT_FROM_NAMES, DetailsForm, SpeakerCountField } from "../components/flow/DetailsForm";
import { ModeCards } from "../components/flow/ModeCards";
import { ParticipantsInput } from "../components/flow/ParticipantsInput";
import type { FlowSecurityClassification, FormField } from "./api";

const noop = () => {};

/** What the page shows: the design system's own words (Valfritt, Ta bort) are in the module's language. */
const renderToStaticMarkup = (element: ReactElement) =>
  render(createElement(InternationalizationProvider, { locale: "sv-SE", messages: { "sv-SE": sv }, children: element }));

/** The words of the element with this id (the first text of it), as a screen reader takes a name or a description. */
const wordsOf = (html: string, id: string) => new RegExp(`id="${id}"[^>]*>(?:<[^>]+>)*([^<]+)`).exec(html)?.[1];
/** The words of what a control names itself by (`aria-labelledby`) or is described by (`aria-describedby`). */
const referenced = (html: string, control: string, attribute: "aria-labelledby" | "aria-describedby") =>
  new RegExp(`${attribute}="([^"]+)"`).exec(control)?.[1].split(" ").map((id) => wordsOf(html, id)).join(" ");

/** A detail's control by the name its field carries (the design system's fields own their ids). */
const control = (html: string, name: string) =>
  new RegExp(`<(?:input|button|textarea)[^>]*data-detail-field="${name}"[^>]*>`).exec(html)?.[0] ?? "";

test("the modes are one radio group under the question, named by it, and only the chosen one is checked", () => {
  const html = renderToStaticMarkup(
    createElement(ModeCards, { modes: ["stromma", "spela-in", "ladda-upp"], mode: "spela-in", onSelect: noop }),
  );
  // The heading takes the focus when the setup appears; the group carries the same words.
  assert.match(html, /<h2[^>]*data-phase-heading[^>]*tabindex="-1"[^>]*>Hur vill du lägga till ljudet\?<\/h2>/);
  const group = /<[^>]*role="radiogroup"[^>]*>/.exec(html)?.[0] ?? "";
  assert.equal(html.match(/role="radiogroup"/g)?.length, 1);
  assert.equal(referenced(html, group, "aria-labelledby"), "Hur vill du lägga till ljudet?");
  const radios = [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map(([control]) => ({
    value: /value="([^"]+)"/.exec(control)?.[1],
    checked: /\schecked=""/.test(control),
    name: referenced(html, control, "aria-labelledby"),
    line: referenced(html, control, "aria-describedby"),
  }));
  // Each is named by its title and described by its line, in the order the page offers them.
  assert.deepEqual(radios, [
    { value: "stromma", checked: false, name: "Strömma", line: "Se texten medan du pratar." },
    { value: "spela-in", checked: true, name: "Spela in", line: "Spela in nu och transkribera efteråt." },
    { value: "ladda-upp", checked: false, name: "Ladda upp", line: "Välj en ljudfil från din enhet." },
  ]);
  // Native radios of one group: the arrow keys and the one Tab stop are the browser's.
  assert.equal(new Set([...html.matchAll(/<input[^>]*type="radio"[^>]*name="([^"]+)"/g)].map(([, name]) => name)).size, 1);
});

test("each participant chip has its own remove button named after the person, and the field says how many it holds", () => {
  const html = renderToStaticMarkup(
    createElement(ParticipantsInput, {
      label: "Deltagare",
      names: ["Anna Berg", "Erik Lund"],
      onChange: noop,
      suggestions: ["Sara Holm", "Anna Berg"],
      fieldName: "deltagare",
    }),
  );
  assert.deepEqual(
    [...html.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map(([, label]) => label),
    ["Ta bort Anna Berg", "Ta bort Erik Lund"],
  );
  assert.match(html, /<ul[^>]*aria-label="Tillagda namn"/, "the names are a named list");
  assert.match(html, /placeholder="Lägg till namn"/);
  // Earlier names are offered, except those already added.
  assert.deepEqual([...html.matchAll(/<option value="([^"]+)"/g)].map(([, name]) => name), ["Sara Holm"]);
  assert.match(html, /<p[^>]*role="status"/, "additions and removals are announced");
  // The input is named by the field's label with its own, and described by the count the group holds.
  const input = control(html, "deltagare");
  assert.equal(referenced(html, input, "aria-labelledby"), "Deltagare Lägg till namn");
  assert.equal(referenced(html, input, "aria-describedby"), "2 namn tillagda.");
  assert.doesNotMatch(html, /Lägg till<\/span>/, "no Lägg till button while nothing is typed");
});

test("labels are sentence case with Valfritt on optional fields, and a missing required field says so at the field", () => {
  const fields: FormField[] = [
    { name: "deltagare", label: "Deltagare", type: "list", required: false },
    { name: "motesnamn", label: "Mötets namn", type: "text", required: true },
    { name: "typ", label: "Mötestyp", type: "select", options: ["Nämnd", "Styrelse"] },
  ];
  const html = renderToStaticMarkup(
    createElement(DetailsForm, {
      fields,
      details: { deltagare: ["Anna Berg"] },
      invalid: ["motesnamn"],
      onChange: noop,
      suggestions: [],
      onNamesAdded: noop,
    }),
  );
  const labelled = (name: string) => new RegExp(`>${name}(?:<span[^>]*>.*?</span>)?</(?:label|span)>`).exec(html)?.[0] ?? "";
  assert.match(labelled("Deltagare"), /Valfritt/);
  assert.match(labelled("Mötestyp"), /Valfritt/);
  assert.doesNotMatch(labelled("Mötets namn"), /Valfritt/, "a required field has no mark");
  assert.match(labelled("Mötets namn"), /^>Mötets namn<\/label>$/);
  assert.match(html, /Skriv ett namn och välj Lägg till\. Skilj flera namn med komma\./);
  const shown = html.replace(/<[^>]+>/g, " ");
  assert.doesNotMatch(shown, /Enter|retur|tryck|klicka|hovra/i, "no key or pointer a phone does not have");
  // What is missing is said at the field: marked invalid, and described by the sentence that says what to do.
  const missing = control(html, "motesnamn");
  assert.match(missing, /aria-invalid="true"/);
  assert.equal(referenced(html, missing, "aria-describedby"), "Fyll i det här för att skapa dokumentet.");
  assert.match(control(html, "typ"), /role="combobox"/, "a select field is our own picker");
  assert.doesNotMatch(html, /<select(?![^>]*aria-hidden="true")/, "never the browser's own list");
  assert.doesNotMatch(html, /eyebrow|uppercase/);
});

test("a missing detail of a flow that makes text says the text, not the document", () => {
  const html = renderToStaticMarkup(
    createElement(DetailsForm, {
      fields: [{ name: "arende", label: "Ärende", type: "text", required: true }],
      details: {},
      invalid: ["arende"],
      onChange: noop,
      suggestions: [],
      onNamesAdded: noop,
      makesText: true,
    }),
  );
  assert.equal(referenced(html, control(html, "arende"), "aria-describedby"), "Fyll i det här för att skapa texten.");
});

test("a required detail says so to a screen reader before sending, and a number field opens a number keyboard", () => {
  const fields: FormField[] = [
    { name: "deltagare", label: "Deltagare", type: "list", required: true },
    { name: "arende", label: "Ärende", type: "text", required: true },
    { name: "typ", label: "Mötestyp", type: "select", options: ["Nämnd", "Styrelse"], required: true },
    { name: "talare", label: "Antal talare", type: "number", required: false },
  ];
  const html = renderToStaticMarkup(
    createElement(DetailsForm, { fields, details: {}, invalid: [], onChange: noop, suggestions: [], onNamesAdded: noop }),
  );
  for (const name of ["deltagare", "arende", "typ"]) assert.match(control(html, name), /aria-required="true"/, name);
  assert.doesNotMatch(control(html, "talare"), /aria-required/);
  assert.match(control(html, "talare"), /inputMode="numeric"|inputmode="numeric"/);
  assert.doesNotMatch(control(html, "arende"), /inputmode/i);
});

test("Antal talare is a light number field with its help below, and a count that is no count says so at the field", () => {
  const field = (value: string) => renderToStaticMarkup(createElement(SpeakerCountField, { value, onChange: noop }));
  const empty = field("");
  assert.match(empty, /<label[^>]*for="[^"]+"[^>]*>Antal talare \(om du vet\)<\/label>/);
  const input = control(empty, "antal-talare");
  // A text field with a number keyboard: a number field reads "e", "-" or "+" as empty and says nothing.
  assert.match(input, /type="text"/);
  assert.match(input, /inputmode="numeric"/i, "a phone's number keyboard");
  assert.match(input, /pattern="\[0-9\]\*"/);
  assert.equal(referenced(empty, input, "aria-describedby"), "Används som övre gräns. Lämna tomt om du är osäker.");
  assert.doesNotMatch(input, /aria-invalid/);
  assert.doesNotMatch(empty, /role="alert"/);

  for (const typed of ["25", "e", "-", "2+"]) {
    const wrong = field(typed);
    const marked = control(wrong, "antal-talare");
    assert.match(marked, /aria-invalid="true"/, typed);
    // Described by its help and by what is wrong, in that order.
    const described = /aria-describedby="([^"]+)"/.exec(marked)?.[1].split(" ").map((id) => wordsOf(wrong, id));
    assert.deepEqual(described, ["Används som övre gräns. Lämna tomt om du är osäker.", "Skriv ett heltal från 1 till 20, eller lämna fältet tomt."], typed);
  }
});

test("a count from the names says so under its field, and names the field's description with it", () => {
  // One wording for a count the names filled in, under this module's field and under the flow's own.
  assert.equal(COUNT_FROM_NAMES, "Ifyllt från antalet deltagare, ändra om fler talar.");
  const hint = COUNT_FROM_NAMES;
  // One helper paragraph, the one the field names: "Lämna tomt" beside a filled-in number would contradict it.
  const own = renderToStaticMarkup(createElement(SpeakerCountField, { value: "2", onChange: noop, fromNames: true }));
  const description = (html: string, name: string) => /aria-describedby="([^"]+)"/.exec(control(html, name))?.[1];
  assert.equal(wordsOf(own, description(own, "antal-talare")!), `Används som övre gräns. ${COUNT_FROM_NAMES}`);
  assert.doesNotMatch(own, /Lämna tomt/);
  const typed = renderToStaticMarkup(createElement(SpeakerCountField, { value: "2", onChange: noop }));
  assert.equal(wordsOf(typed, description(typed, "antal-talare")!), "Används som övre gräns. Lämna tomt om du är osäker.");
  assert.doesNotMatch(typed, /Ifyllt från antalet deltagare/);

  const antal: FormField = { name: "antal", label: "Antal talare", type: "number", required: false };
  const form = (notes?: Record<string, string>) =>
    renderToStaticMarkup(
      createElement(DetailsForm, { fields: [antal], details: { antal: "2" }, invalid: [], onChange: noop, suggestions: [], onNamesAdded: noop, notes }),
    );
  assert.equal(wordsOf(form({ antal: hint }), description(form({ antal: hint }), "antal")!), hint, "the flow's own count field says it too");
  assert.ok(!form().includes(hint));
});

test("a form with no fields shows nothing, and details of the wrong type or kinds the page does not know do no harm", () => {
  const form = (fields: FormField[], details: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(DetailsForm, { fields, details: details as never, invalid: [], onChange: noop, suggestions: [], onNamesAdded: noop }),
    );
  assert.equal(form([], {}), "");
  // An array where text goes, and a string where a list goes: read as nothing, not shown as something.
  const wrong = form(
    [
      { name: "arende", label: "Ärende", type: "text" },
      { name: "deltagare", label: "Deltagare", type: "list" },
    ],
    { arende: ["x"], deltagare: "Anna" },
  );
  assert.match(control(wrong, "arende"), /value=""/);
  assert.doesNotMatch(wrong, /Ta bort/);
  // A long text is a labelled text box of four lines; a kind nobody knows is a text field; a choice with no real
  // option is a text field too, not an empty list.
  const kinds = form(
    [
      { name: "berattelse", label: "Berättelse", type: "long_text" },
      { name: "okand", label: "Okänd", type: "colour" },
      { name: "tom", label: "Tom", type: "select", options: ["", "  "].slice(0, 1) },
      { name: "ingen", label: "Ingen", type: "select", options: "ja" as never },
    ],
    {},
  );
  assert.match(kinds, /<textarea[^>]*data-detail-field="berattelse"[^>]*rows="4"|<textarea[^>]*rows="4"[^>]*data-detail-field="berattelse"/);
  for (const name of ["okand", "tom", "ingen"]) assert.match(control(kinds, name), /^<input[^>]*type="text"/, name);
});

test("the information row is the flow's classification as Eneo sends it, and there is none without one", () => {
  const row = (classification: FlowSecurityClassification | null) =>
    renderToStaticMarkup(createElement(ClassificationNote, { classification }));

  const full = row({
    name: "Öppen information",
    description: "Ladda inte upp personuppgifter eller uppgifter som omfattas av sekretess.",
    security_level: 0,
  });
  assert.match(full, /^<div [^>]*role="note"/, "a note, not an alert or a status");
  assert.match(full, />Öppen information<\/span>/);
  assert.match(full, />Ladda inte upp personuppgifter eller uppgifter som omfattas av sekretess\.<\/span>/);
  assert.doesNotMatch(full, /truncate|line-clamp/, "a long description wraps");

  const nameOnly = row({ name: "Intern information", description: null, security_level: 1 });
  assert.match(nameOnly, />Intern information<\/span>/);
  assert.equal(nameOnly.match(/<span/g)?.length, 1, "the name alone, no empty description");

  assert.equal(row(null), "", "no classification: no row, and no invented rule");
});

test("the microphone is a labelled field like the others: the label above, the chosen device in the trigger", async () => {
  const { MicrophoneCheck } = await import("../components/flow/MicrophoneCheck");
  const html = renderToStaticMarkup(createElement(MicrophoneCheck, { active: true }));
  const id = /<label[^>]*for="([^"]+)"[^>]*>Mikrofon<\/label>/.exec(html)?.[1];
  assert.ok(id, "a label above the control, without a colon");
  const trigger = new RegExp(`<button[^>]*role="combobox"[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? new RegExp(`<button[^>]*id="${id}"[^>]*role="combobox"[^>]*>`).exec(html)?.[0];
  assert.ok(trigger, "the label names the picker");
  assert.doesNotMatch(trigger, /aria-label=/, "no name that hides the chosen device");
  assert.doesNotMatch(html, /<select(?![^>]*aria-hidden="true")/, "not the browser's own list");
  assert.match(html, />Testa mikrofonen</);
});
