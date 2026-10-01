import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "next-themes";

import { ModuleProviders } from "../kit/ModuleProviders";
import { ClassificationNote } from "../components/flow/ClassificationNote";
import { COUNT_FROM_NAMES, DetailsForm, SpeakerCountField } from "../components/flow/DetailsForm";
import { ModeCards } from "../components/flow/ModeCards";
import { ParticipantsInput } from "../components/flow/ParticipantsInput";
import type { FlowSecurityClassification, FormField } from "./api";

const noop = () => {};

/** The page's own providers, so the design system's words are Swedish as they are on the page. */
const render = (element: ReactElement) =>
  renderToStaticMarkup(createElement(ThemeProvider, { attribute: "class", children: createElement(ModuleProviders, { children: element }) }));

// The theme provider adds a script that sets the colour mode before the first paint; it is not the page's words.
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
/** The text of the element with this id. */
const textOf = (html: string, id: string) => text(new RegExp(`<(\\w+)[^>]*\\sid="${id}"[^>]*>([\\s\\S]*?)</\\1>`).exec(html)?.[2] ?? "");
/** The control a detail carries, by the name Eneo gave it (the page finds it by this to move focus). */
const control = (html: string, field: string) =>
  html.match(new RegExp(`<(?:input|button|textarea)[^>]*data-detail-field="${field}"[^>]*>`))?.[0] ?? "";
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag)?.[1];
/** What the control is named by: its <label for>, or the first of the elements it is labelled by. */
const nameOf = (html: string, tag: string) => {
  const id = attr(tag, "id");
  const label = new RegExp(`<label[^>]*for="${id}"[^>]*>([\\s\\S]*?)</label>`).exec(html)?.[1];
  return label !== undefined ? text(label) : textOf(html, (attr(tag, "aria-labelledby") ?? "").split(" ")[0]);
};
/** What the control is described by. */
const describedBy = (html: string, tag: string) => (attr(tag, "aria-describedby") ?? "").split(" ").filter(Boolean).map((id) => textOf(html, id));

test("the modes are one radio group under the question, and only the chosen one is checked", () => {
  const html = render(createElement(ModeCards, { modes: ["stromma", "spela-in", "ladda-upp"], mode: "spela-in", onSelect: noop }));
  assert.match(html, /<h2[^>]*data-phase-heading[^>]*tabindex="-1"[^>]*>Hur vill du lägga till ljudet\?<\/h2>/i, "the question takes focus when the setup appears");
  assert.equal(html.match(/role="radiogroup"/g)?.length, 1);
  assert.equal(textOf(html, attr(html.match(/<div[^>]*role="radiogroup"[^>]*>/)![0], "aria-labelledby")!), "Hur vill du lägga till ljudet?", "the group is named by the question");
  const radios = [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map(([tag]) => tag);
  assert.equal(radios.length, 3, "native radios");
  assert.deepEqual(
    radios.map((tag) => [attr(tag, "value"), /\schecked=""/.test(tag)]),
    [
      ["stromma", false],
      ["spela-in", true],
      ["ladda-upp", false],
    ],
  );
  // Each radio is named by the mode and described by its line.
  assert.deepEqual(
    radios.map((tag) => [nameOf(html, tag), describedBy(html, tag)[0]]),
    [
      ["Strömma", "Se texten medan du pratar."],
      ["Spela in", "Spela in nu och transkribera efteråt."],
      ["Ladda upp", "Välj en ljudfil från din enhet."],
    ],
  );
});

test("each participant has its own remove button named after the person, and the field says how many there are", () => {
  const html = render(
    createElement(ParticipantsInput, {
      label: "Deltagare",
      names: ["Anna Berg", "Erik Lund"],
      onChange: noop,
      suggestions: ["Sara Holm", "Anna Berg"],
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
  assert.match(html, /role="status"/, "additions and removals are announced");
  const field = html.match(/<input[^>]*type="text"[^>]*>/)![0];
  assert.deepEqual(describedBy(html, field), ["2 namn tillagda."], "the count is the field's description, not hidden text");
});

test("optional fields are marked, a required one is not and says so to a screen reader, and a missing one says so at the field", () => {
  const fields: FormField[] = [
    { name: "deltagare", label: "Deltagare", type: "list", required: false },
    { name: "motesnamn", label: "Mötets namn", type: "text", required: true },
    { name: "typ", label: "Mötestyp", type: "select", options: ["Nämnd", "Styrelse"], required: true },
    { name: "talare", label: "Antal talare", type: "number", required: false },
    { name: "kategori", label: "Kategori", type: "select", options: ["A", "B"] },
  ];
  const html = render(
    createElement(DetailsForm, {
      fields,
      details: { deltagare: ["Anna Berg"] },
      invalid: ["motesnamn"],
      onChange: noop,
      suggestions: [],
      onNamesAdded: noop,
    }),
  );
  const named = (field: string) => nameOf(html, control(html, field));
  assert.match(named("deltagare"), /^Deltagare\s*∙\s*Valfritt/, "an optional field is marked");
  assert.equal(named("motesnamn"), "Mötets namn", "a required field has no mark");
  assert.equal(named("typ"), "Mötestyp");
  assert.match(named("kategori"), /^Kategori\s*∙\s*Valfritt/);
  assert.match(html, /Skriv ett namn och välj Lägg till\. Skilj flera namn med komma\./);
  assert.doesNotMatch(text(html), /Enter|retur|tryck|klicka|hovra/i, "no key or pointer a phone does not have");
  // A required detail says so before sending too, not only once the send finds it missing.
  for (const field of ["motesnamn", "typ"]) {
    const tag = control(html, field);
    assert.match(tag, /aria-required="true"/, field);
  }
  assert.doesNotMatch(control(html, "deltagare"), /aria-required/);
  assert.doesNotMatch(control(html, "talare"), /aria-required/);
  assert.doesNotMatch(control(html, "kategori"), /aria-required/);
  const missing = control(html, "motesnamn");
  assert.match(missing, /aria-invalid="true"/);
  assert.ok(describedBy(html, missing).includes("Fyll i det här för att skapa dokumentet."), "said at the field, not in an alert");
  assert.doesNotMatch(html, /role="alert"/);
  assert.match(control(html, "typ"), /role="combobox"/, "a select field is the design system's picker");
  assert.doesNotMatch(html, /<select/, "never the browser's own list");
  assert.doesNotMatch(html, /eyebrow|uppercase/);
});

test("a missing detail of a flow that makes text says the text, not the document", () => {
  const html = render(
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
  assert.ok(describedBy(html, control(html, "arende")).includes("Fyll i det här för att skapa texten."));
});

test("a number field opens a number keyboard, and no other detail does", () => {
  const fields: FormField[] = [
    { name: "arende", label: "Ärende", type: "text", required: true },
    { name: "talare", label: "Antal talare", type: "number", required: false },
  ];
  const html = render(createElement(DetailsForm, { fields, details: {}, invalid: [], onChange: noop, suggestions: [], onNamesAdded: noop }));
  assert.match(control(html, "talare"), /inputMode="numeric"|inputmode="numeric"/i);
  assert.doesNotMatch(control(html, "arende"), /inputmode/i);
});

test("a detail of the wrong type is shown as no value, and a select with nothing to choose from is a text field", () => {
  const fields: FormField[] = [
    { name: "text", label: "Text", type: "text" },
    { name: "namn", label: "Namn", type: "list" },
    { name: "val", label: "Val", type: "select", options: [] },
    { name: "val2", label: "Val 2", type: "select", options: ["", ""] },
    { name: "val3", label: "Val 3", type: "select" },
  ];
  const html = render(
    createElement(DetailsForm, {
      fields,
      // An array for a text field, a string for a list: Eneo's data is not ours to trust.
      details: { text: ["x"], namn: "Anna" } as never,
      invalid: [],
      onChange: noop,
      suggestions: [],
      onNamesAdded: noop,
    }),
  );
  assert.match(control(html, "text"), /value=""/);
  assert.doesNotMatch(html, /Tillagda namn/, "a string is no list of names");
  for (const field of ["val", "val2", "val3"]) assert.match(control(html, field), /^<input[^>]*type="text"/, `${field}: nothing to choose from is text`);
  assert.doesNotMatch(html, /role="combobox"/);
});

test("Antal talare is a light number field with its help below, and a count that is no count says so at the field", () => {
  const field = (value: string) => render(createElement(SpeakerCountField, { value, onChange: noop }));
  const empty = field("");
  const input = control(empty, "antal-talare");
  assert.equal(nameOf(empty, input), "Antal talare (om du vet)");
  // A text field with a number keyboard: a number field reads "e", "-" or "+" as empty and says nothing.
  assert.match(input, /type="text"/);
  assert.match(input, /inputmode="numeric"/i, "a phone's number keyboard");
  assert.match(input, /pattern="\[0-9\]\*"/);
  assert.deepEqual(describedBy(empty, input), ["Används som övre gräns. Lämna tomt om du är osäker."]);
  assert.doesNotMatch(input, /aria-invalid/);
  assert.doesNotMatch(empty, /role="alert"/);

  for (const typed of ["25", "e", "-", "2+"]) {
    const wrong = field(typed);
    const tag = control(wrong, "antal-talare");
    assert.match(tag, /aria-invalid="true"/, typed);
    assert.deepEqual(
      describedBy(wrong, tag),
      ["Används som övre gräns. Lämna tomt om du är osäker.", "Skriv ett heltal från 1 till 20, eller lämna fältet tomt."],
      typed,
    );
  }
});

test("a count from the names says so under its field, and the field is described by that one sentence pair", () => {
  // One wording for a count the names filled in, under this module's field and under the flow's own.
  assert.equal(COUNT_FROM_NAMES, "Ifyllt från antalet deltagare, ändra om fler talar.");
  const hint = COUNT_FROM_NAMES;
  // One description, the one the field names: "Lämna tomt" beside a filled-in number would contradict it.
  const own = render(createElement(SpeakerCountField, { value: "2", onChange: noop, fromNames: true }));
  assert.deepEqual(describedBy(own, control(own, "antal-talare")), ["Används som övre gräns. Ifyllt från antalet deltagare, ändra om fler talar."]);
  assert.doesNotMatch(own, /Lämna tomt/);
  const typed = render(createElement(SpeakerCountField, { value: "2", onChange: noop }));
  assert.deepEqual(describedBy(typed, control(typed, "antal-talare")), ["Används som övre gräns. Lämna tomt om du är osäker."]);
  assert.doesNotMatch(typed, /Ifyllt från antalet deltagare/);

  const antal: FormField = { name: "antal", label: "Antal talare", type: "number", required: false };
  const form = (notes?: Record<string, string>) =>
    render(createElement(DetailsForm, { fields: [antal], details: { antal: "2" }, invalid: [], onChange: noop, suggestions: [], onNamesAdded: noop, notes }));
  assert.deepEqual(describedBy(form({ antal: hint }), control(form({ antal: hint }), "antal")), [hint]);
  assert.ok(!form().includes(hint));
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
  const html = render(createElement(MicrophoneCheck, { active: true }));
  const trigger = html.match(/<button[^>]*role="combobox"[^>]*>/)?.[0];
  assert.ok(trigger, "one picker");
  assert.equal(nameOf(html, trigger), "Mikrofon", "a label above the control, without a colon");
  assert.doesNotMatch(trigger, /aria-label=/, "no name that hides the chosen device");
  assert.doesNotMatch(html, /<select/, "not the browser's own list");
  assert.match(html, />Testa mikrofonen</);
});
