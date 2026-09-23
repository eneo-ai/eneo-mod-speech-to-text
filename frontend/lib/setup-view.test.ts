import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DetailsForm } from "../components/flow/DetailsForm";
import { ModeCards } from "../components/flow/ModeCards";
import { ParticipantsInput } from "../components/flow/ParticipantsInput";
import type { FormField } from "./api";

const noop = () => {};

test("the modes are one radio group of equal cards under the question, and only the chosen one is checked", () => {
  const html = renderToStaticMarkup(
    createElement(ModeCards, { modes: ["stromma", "spela-in", "ladda-upp"], mode: "spela-in", onSelect: noop }),
  );
  assert.match(html, /<fieldset[^>]*>.*<legend[^>]*><h2[^>]*>Hur vill du ge ljudet\?<\/h2><\/legend>/s);
  assert.equal(html.match(/role="radiogroup"/g)?.length, 1);
  const radios = [...html.matchAll(/<button[^>]*role="radio"[^>]*aria-checked="(true|false)"[^>]*id="satt-([a-z-]+)"/g)];
  assert.deepEqual(
    radios.map(([, checked, id]) => [id, checked]),
    [
      ["stromma", "false"],
      ["spela-in", "true"],
      ["ladda-upp", "false"],
    ],
  );
  for (const [name, line] of [
    ["Strömma", "Se texten medan du pratar."],
    ["Spela in", "Spela in nu och transkribera efteråt."],
    ["Ladda upp", "Välj en ljudfil från din enhet."],
  ]) {
    assert.ok(html.includes(`>${name}</div>`) && html.includes(`>${line}</p>`), name);
  }
  // Each card is the radio's label, so the whole card selects it.
  assert.equal(html.match(/<label[^>]*for="satt-/g)?.length, 3);
});

test("each participant chip has its own remove button named after the person", () => {
  const html = renderToStaticMarkup(
    createElement(ParticipantsInput, {
      id: "deltagare",
      names: ["Anna Berg", "Erik Lund"],
      onChange: noop,
      suggestions: ["Sara Holm", "Anna Berg"],
    }),
  );
  assert.deepEqual(
    [...html.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map(([, label]) => label),
    ["Ta bort Anna Berg", "Ta bort Erik Lund"],
  );
  assert.match(html, /placeholder="Lägg till namn"/);
  // Earlier names are offered, except those already added.
  assert.deepEqual([...html.matchAll(/<option value="([^"]+)"/g)].map(([, name]) => name), ["Sara Holm"]);
  assert.match(html, /role="status"/, "additions and removals are announced");
});

test("labels are sentence case with (valfritt) on optional fields, and a missing required field says so at the field", () => {
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
  assert.match(html, /for="detalj-deltagare"[^>]*>Deltagare <span[^>]*>\(valfritt\)<\/span>/);
  assert.match(html, /for="detalj-motesnamn"[^>]*>Mötets namn <\/label>/, "a required field has no mark");
  assert.match(html, /Skriv ett namn och tryck Enter\./);
  assert.match(html, /id="detalj-motesnamn"[^>]*aria-describedby="detalj-motesnamn-fel"[^>]*aria-invalid="true"/);
  assert.match(html, /id="detalj-motesnamn-fel"[^>]*>Fyll i det här för att skapa dokumentet\.</);
  assert.match(html, /<select[^>]*id="detalj-typ"/, "a select field offers its options");
  assert.doesNotMatch(html, /eyebrow|uppercase/);
});
