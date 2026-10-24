import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { ApiError } from "./api";
import { buildEditedMapping, namingRefusal, withSplitLabels, type SpeakerMappingRow } from "./speaker-mapping";
import { computeAccessibleDescription, computeAccessibleName } from "dom-accessibility-api";
import { button, cleanup, installDom, mount, type } from "./test-dom";

installDom();
afterEach(cleanup);

const row = (label: string, name: string | null, lineCount = 3): SpeakerMappingRow => ({
  label, name, lineCount, samples: [], confidence: "medium", evidence: "",
});
const rows = [row("SPEAKER_00", "Anna Berg", 12), row("SPEAKER_01", null, 9)];

/** Mounts what the page mounts it in: the design system's words are Swedish (Stäng) only inside the providers. */
async function mountInProviders(element: import("react").ReactElement) {
  const { createElement } = await import("react");
  const { ModuleProviders } = await import("../kit/ModuleProviders");
  return mount(createElement(ModuleProviders, { children: element }));
}

async function dialog(props: Record<string, unknown> = {}) {
  const { createElement } = await import("react");
  const { SpeakerNamingDialog } = await import("../components/SpeakerNamingDialog");
  const saved: SpeakerMappingRow[][] = [];
  const listened: string[] = [];
  const view = await mountInProviders(
    createElement(SpeakerNamingDialog, {
      rows,
      participants: ["Anna Berg", "Erik Lund", "Sara Holm"],
      passages: (label: string) => (label === "SPEAKER_00" ? 12 : 9),
      quote: (label: string) => (label === "SPEAKER_00" ? "Välkomna till mötet." : "Första punkten gäller budgeten."),
      onListen: (label: string) => void listened.push(label),
      onSave: async (next: SpeakerMappingRow[]) => {
        saved.push(next);
        return null;
      },
      children: createElement("button", { type: "button" }, "Namnge talarna"),
      ...props,
    }),
  );
  const trigger = button(view.container, "Namnge talarna")!;
  await view.act(async () => trigger.click());
  return { view, trigger, field: nameFieldOf, saved, listened };
}

/** The dialog's footer actions as [label, variant]: the last buttons in the open dialog, after the rows' own. */
function footerActions(count: number): [string | undefined, string | null][] {
  return [...document.querySelectorAll<HTMLButtonElement>("dialog[open] button")]
    .slice(-count)
    .map((action) => [action.textContent?.trim(), action.getAttribute("data-variant")]);
}

/** The name field of a speaker, found as a screen reader names it, in the dialog that is open. */
function nameFieldOf(label: string): HTMLInputElement {
  return fieldNamed(`Vem är ${label}?`)!;
}
function fieldNamed(name: string): HTMLInputElement | null {
  return [...document.querySelectorAll<HTMLInputElement>("dialog[open] input")].find((input) => computeAccessibleName(input) === name) ?? null;
}

test("each speaker is a row: the mark, how many passages, what they say first, a sample and a name", async () => {
  const { view, field, listened } = await dialog();
  const content = document.querySelector("dialog[open]")!;
  assert.match(content.textContent ?? "", /Namnge talarna/);
  assert.match(content.textContent ?? "", /Talare 1 · 12 inlägg”Välkomna till mötet\.”/);
  assert.match(content.textContent ?? "", /Talare 2 · 9 inlägg”Första punkten gäller budgeten\.”/);
  assert.equal(field("Talare 1").value, "Anna Berg");
  assert.equal(field("Talare 2").value, "", "no name is assumed for the other speaker");
  await view.act(async () => button(document.body, "Lyssna på exempel: Talare 2")!.click());
  assert.deepEqual(listened, ["SPEAKER_01"]);
});

test("a sample that plays says so and can be stopped; closing the dialog stops it too", async () => {
  const stops: number[] = [];
  const { view, listened } = await dialog({ listening: "SPEAKER_01", onStopListening: () => void stops.push(1) });
  assert.equal(button(document.body, "Lyssna på exempel: Talare 1")?.textContent, "Lyssna på exempel");
  const stop = button(document.body, "Stoppa exempel: Talare 2");
  assert.equal(stop?.textContent, "Stoppa exempel", "the playing sample shows it plays");
  await view.act(async () => stop!.click());
  assert.equal(stops.length, 1);
  assert.deepEqual(listened, [], "stopping plays nothing");
  await view.act(async () => button(document.body, "Stäng")!.click());
  assert.equal(stops.length, 2, "closing stops the sample");
});

test("why a sample cannot be played is a line under the row, not only a hover title", async () => {
  const reason = "Det finns inget tilldelat exempel utan överlappande tal.";
  const { field } = await dialog({ listenUnavailableReason: (label: string) => (label === "SPEAKER_01" ? reason : null) });
  const rowOf = (label: string) => field(label).closest("li")!;
  assert.equal(button(rowOf("Talare 2"), "Lyssna på exempel: Talare 2")?.disabled, true);
  assert.match(rowOf("Talare 2").textContent ?? "", /Det finns inget tilldelat exempel utan överlappande tal\./);
  assert.doesNotMatch(rowOf("Talare 1").textContent ?? "", /Det finns inget tilldelat exempel/);
});

test("opening a filled name field by click and pressing Enter keeps its name", async () => {
  // Run 82089959: Talare 2 was "Erik", a click then Enter made it "Anna" in the transcript and the PDF.
  const { view, field, saved } = await dialog({ rows: [row("SPEAKER_00", "Anna Berg", 12), row("SPEAKER_01", "Erik Lund", 9)] });
  const erik = field("Talare 2");
  await view.act(async () => erik.click());
  const active = document.getElementById(erik.getAttribute("aria-activedescendant") ?? "");
  assert.equal(active?.textContent?.startsWith("Erik Lund"), true, "the list opens on the field's own name");
  await view.act(async () => erik.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  assert.equal(field("Talare 2").value, "Erik Lund");
  await view.act(async () => button(document.body, "Spara namnen")!.click());
  assert.deepEqual(saved.at(-1)?.map((r) => r.name), ["Anna Berg", "Erik Lund"]);
});

/** One name field on its own, holding what is chosen, driven by the keyboard. */
async function nameField(value: string | null, options: string[]) {
  const { createElement, useState } = await import("react");
  const { NameCombobox } = await import("../components/NameCombobox");
  function Field() {
    const [name, setName] = useState<string | null>(value);
    return createElement(NameCombobox, { value: name, options, onChange: setName, label: "Vem är Talare 2?", placeholder: "Välj eller skriv ett namn", noneLabel: "Ingen (behåll etiketten)" });
  }
  const view = await mount(createElement(Field));
  const input = view.container.querySelector("input")!;
  const key = (k: string) => view.act(async () => input.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true })));
  const option = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.startsWith(name))!;
  const marked = () => document.getElementById(input.getAttribute("aria-activedescendant") ?? "")?.textContent ?? null;
  return { view, input, key, option, marked };
}

test("a speaker's name is not marked as misspelt or autocorrected, and a phone's keyboard starts each word with a capital, as for participants", async () => {
  const { input } = await nameField(null, ["Anna Berg"]);
  assert.equal(input.getAttribute("spellcheck"), "false");
  // spellcheck="false" leaves iOS's autocorrect on: "Maja" became "Mana" when the focus moved on.
  assert.equal(input.getAttribute("autocorrect"), "off");
  assert.equal(input.getAttribute("autocapitalize"), "words");
});

test("a name list closes when the focus moves on without Tab, as a phone keyboard's arrows or its Next move it", async () => {
  const { view, input } = await nameField("Erik Lund", ["Anna Berg", "Erik Lund"]);
  const next = document.createElement("input");
  document.body.append(next);
  await view.act(async () => input.focus());
  await view.act(async () => input.click());
  assert.equal(input.getAttribute("aria-expanded"), "true");
  await view.act(async () => {
    next.focus();
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  assert.equal(input.getAttribute("aria-expanded"), "false", "the list no longer covers the next speaker's row");
  next.remove();
});

test("the chevron reopens a name list on the field's own name, not on a row left before Escape", async () => {
  const { view, input, key } = await nameField("Erik Lund", ["Anna Berg", "Erik Lund"]);
  await view.act(async () => input.focus());
  await key("ArrowUp");
  await key("Escape");
  // The field keeps the focus, so only the chevron's own opening can clear the row left behind.
  await view.act(async () => view.container.querySelector<HTMLButtonElement>('button[aria-label="Visa namn"]')!.click());
  await key("Enter");
  assert.equal(input.value, "Erik Lund");
});

test("an arrow key opens a closed name list on the first suggestion, or the last", async () => {
  const { view, input, key, marked } = await nameField(null, ["Anna Berg", "Erik Lund"]);
  await view.act(async () => input.focus());
  await key("Escape");
  await key("ArrowUp");
  assert.equal(marked(), "Ingen (behåll etiketten)", "up opens on the last row");
  await key("Escape");
  await key("ArrowDown");
  assert.equal(marked(), "Anna Berg", "down opens on the first suggestion");
  await key("Enter");
  assert.equal(input.value, "Anna Berg");
});

test("a list opened on a name far down shows that name", async (t) => {
  const names = Array.from({ length: 20 }, (_, i) => `Namn ${i + 1}`);
  const shown: string[] = [];
  const original = window.Element.prototype.scrollIntoView;
  window.Element.prototype.scrollIntoView = function (this: Element) {
    shown.push(this.textContent ?? "");
  };
  t.after(() => void (window.Element.prototype.scrollIntoView = original));
  const { view, input } = await nameField("Namn 19", names);
  await view.act(async () => input.click());
  assert.ok(shown.some((text) => text.startsWith("Namn 19")), `scrolled to: ${JSON.stringify(shown)}`);
});

test("a pasted name and Enter keep that name, also where the list opens under a resting pointer", async () => {
  // JD-01: "Bertil Eklund" pasted from the invitation became "Talare 2" in the transcript and the PDF.
  const { view, input, key, option } = await nameField(null, ["Anna Berg", "Erik Lund"]);
  await view.act(async () => type(input, "Bertil Eklund"));
  // The list appears under a pointer that has not moved: that is no choice of a row.
  await view.act(async () => option("Ingen").dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true })));
  await key("Enter");
  assert.equal(input.value, "Bertil Eklund");
});

test("the start of a participant's name and Enter keep what was typed; the arrow keys pick the longer name", async () => {
  const { view, input, key, marked } = await nameField(null, ["Testperson 1 Efternamn", "Testperson 10 Efternamn"]);
  await view.act(async () => type(input, "Testperson 1"));
  await key("Enter");
  assert.equal(input.value, "Testperson 1");
  await view.act(async () => type(input, "Testperson 10"));
  await key("ArrowDown");
  assert.equal(marked(), "Testperson 10 Efternamn");
  await key("Enter");
  assert.equal(input.value, "Testperson 10 Efternamn");
});

test("moving to a name field does not open its list; a click, typing or the down arrow does", async () => {
  // A list opened on focus covers the next row on every Tab.
  const { view, input, key } = await nameField("Erik Lund", ["Anna Berg", "Erik Lund"]);
  await view.act(async () => input.focus());
  assert.equal(input.getAttribute("aria-expanded"), "false");
  assert.equal(document.querySelector('[role="listbox"]'), null);
  await key("ArrowDown");
  assert.equal(input.getAttribute("aria-expanded"), "true");
  await key("Escape");
  await view.act(async () => input.click());
  assert.equal(input.getAttribute("aria-expanded"), "true");
});

test("inside the list, the row the keys are on is the selected one; the saved name keeps its check", async () => {
  const { view, input, key, option } = await nameField("Erik Lund", ["Anna Berg", "Erik Lund"]);
  await view.act(async () => input.click());
  await key("ArrowUp");
  assert.equal(option("Anna Berg").getAttribute("aria-selected"), "true");
  assert.equal(option("Erik Lund").getAttribute("aria-selected"), "false");
  assert.ok(option("Erik Lund").querySelector(".lucide-check"), "the name in the field still shows its check");
});

test("Enter ends a speaker's name and goes on to the next speaker's field; on the last it goes to Spara namnen and saves nothing", async () => {
  const { view, field, saved } = await dialog();
  const enter = (input: HTMLInputElement) =>
    view.act(async () => input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  // What a phone's key says it does: on to the next field, and done on the last.
  assert.equal(field("Talare 1").getAttribute("enterkeyhint"), "next");
  assert.equal(field("Talare 2").getAttribute("enterkeyhint"), "done");
  await view.act(async () => field("Talare 1").focus());
  await enter(field("Talare 1"));
  assert.equal(document.activeElement, field("Talare 2"), "a closed list: Enter goes on");
  await view.act(async () => field("Talare 1").focus());
  await view.act(async () => type(field("Talare 1"), "Sven"));
  assert.equal(field("Talare 1").getAttribute("aria-expanded"), "true", "typing opens the list");
  await enter(field("Talare 1"));
  assert.equal(document.activeElement, field("Talare 2"), "a list opened by typing: Enter keeps the name and goes on");
  assert.equal(field("Talare 1").value, "Sven");
  assert.equal(field("Talare 1").getAttribute("aria-expanded"), "false");
  await view.act(async () => type(field("Talare 2"), "Maja"));
  await enter(field("Talare 2"));
  assert.equal(document.activeElement, button(document.body, "Spara namnen"), "the last: the keyboard goes, Spara namnen has the focus");
  assert.ok(document.querySelector("dialog[open]"), "a stray Enter sends nothing: the dialog stays open");
  assert.deepEqual(saved, []);
  assert.equal(field("Talare 2").value, "Maja");
});

test("a finger that scrolls a name list marks no row, so Enter keeps the typed name and goes on; a mouse marks the row it is on, and a tap chooses", async () => {
  const { view, field } = await dialog();
  const enter = (input: HTMLInputElement) =>
    view.act(async () => input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  const option = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.startsWith(name))!;
  const over = (row: Element, pointerType: string) =>
    view.act(async () => row.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, pointerType })));
  await view.act(async () => field("Talare 1").focus());
  await view.act(async () => type(field("Talare 1"), "Sven"));
  // A swipe through the list on a phone: the finger passes over Inget namn.
  await over(option("Inget namn"), "touch");
  assert.equal(option("Inget namn").getAttribute("aria-selected"), "false", "a finger's move marks nothing");
  await enter(field("Talare 1"));
  assert.equal(field("Talare 1").value, "Sven", "the typed name stands");
  assert.equal(document.activeElement, field("Talare 2"), "Enter goes on to the next speaker");
  // A mouse over a row marks it, and Enter takes it.
  await view.act(async () => type(field("Talare 2"), "Er"));
  await over(option("Erik Lund"), "mouse");
  assert.equal(option("Erik Lund").getAttribute("aria-selected"), "true", "a mouse marks the row it is on");
  await enter(field("Talare 2"));
  assert.equal(field("Talare 2").value, "Erik Lund");
  // A tap on a row still chooses it.
  await view.act(async () => field("Talare 1").click());
  await view.act(async () => option("Sara Holm").click());
  assert.equal(field("Talare 1").value, "Sara Holm");
});

test("a new name typed for a speaker is offered to add, not listed as a name already known", async () => {
  const { view, field } = await dialog();
  await view.act(async () => type(field("Talare 2"), "Sven"));
  const options = [...document.querySelectorAll('[aria-label="Förslag: Vem är Talare 2?"] [role="option"]')].map((o) => o.textContent);
  assert.ok(options.includes("Lägg till ”Sven”"), JSON.stringify(options));
  assert.ok(!options.includes("Sven"), "the field's own text is not a known name");
});

test("a name given to another speaker is said quietly, and only the row's own name is checked", async () => {
  const { view, field } = await dialog();
  // Opened by a click, so the list marks the field's own name (an arrow key would move to a row).
  await view.act(async () => field("Talare 2").click());
  const options = [...document.querySelectorAll<HTMLElement>('[aria-label="Förslag: Vem är Talare 2?"] [role="option"]')];
  const anna = options.find((o) => o.textContent?.startsWith("Anna Berg"))!;
  assert.equal(anna.textContent, "Anna BergRedan kopplad till Talare 1");
  assert.equal(anna.getAttribute("aria-selected"), "false");
  assert.ok(!anna.querySelector("svg"), "no check on a name another speaker has");
  assert.ok(options.some((o) => o.textContent === "Skriv ett annat namn"));

  await view.act(async () => field("Talare 1").click());
  const own = [...document.querySelectorAll<HTMLElement>('[aria-label="Förslag: Vem är Talare 1?"] [role="option"]')].find((o) => o.textContent === "Anna Berg")!;
  assert.equal(own.getAttribute("aria-selected"), "true");
  assert.ok(own.querySelector("svg"), "the row's own choice is checked");
});

test("the dialog saves names only: its footer is Avbryt and a primary Spara namnen, and approving stays the page's", async () => {
  await dialog();
  assert.deepEqual(footerActions(2), [["Avbryt", "ghost"], ["Spara namnen", "primary"]]);
  assert.ok(
    ![...document.querySelectorAll("dialog[open] button")].some((action) => /fortsätt/i.test(action.textContent ?? "")),
    "nothing in the dialog lets the flow go on",
  );
});

test("Spara namnen saves trimmed names, closes and gives the focus back", async () => {
  const { view, trigger, field, saved } = await dialog();
  await view.act(async () => type(field("Talare 2"), "  Erik Lund  "));
  await view.act(async () => button(document.body, "Spara namnen")!.click());
  assert.deepEqual(saved[0].map((r) => [r.label, r.name]), [["SPEAKER_00", "Anna Berg"], ["SPEAKER_01", "Erik Lund"]]);
  assert.ok(!document.querySelector("dialog[open]"), "closed");
  // The focus goes back in an effect after closing; wait a turn. Compare as a boolean: a failed
  // comparison of two DOM nodes makes node print them, which takes minutes under jsdom.
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.ok(document.activeElement === trigger, "focus back on the button that opened it");
});

test("a name with a line break or a tab is not saved, and says why", async () => {
  const { view, field, saved } = await dialog();
  await view.act(async () => type(field("Talare 2"), "Erik\tLund"));
  await view.act(async () => button(document.body, "Spara namnen")!.click());
  assert.equal(saved.length, 0);
  assert.match(document.querySelector("dialog[open]")?.textContent ?? "", /Ett namn är en rad/);
  assert.equal(field("Talare 2").getAttribute("aria-invalid"), "true", "the field says it is refused");
});

test("a refused save stays open with Eneo's reason", async () => {
  const { view, field } = await dialog({ onSave: async () => "Granskningen har ändrats sedan du laddade sidan." });
  await view.act(async () => type(field("Talare 2"), "Erik Lund"));
  await view.act(async () => button(document.body, "Spara namnen")!.click());
  assert.ok(document.querySelector("dialog[open]"), "still open");
  assert.match(document.querySelector('dialog[open] [role="alert"]')?.textContent ?? "", /Granskningen har ändrats/);
  assert.equal(field("Talare 2").value, "Erik Lund", "with the names kept");
});

test("a speaker split off in the review can be named; it is sent only with a name", () => {
  const withSplit = withSplitLabels(rows, ["SPEAKER_01", "SPEAKER_05", null]);
  assert.deepEqual(withSplit.map((r) => [r.label, Boolean(r.split)]), [["SPEAKER_00", false], ["SPEAKER_01", false], ["SPEAKER_05", true]]);
  assert.deepEqual(buildEditedMapping(withSplit).speakers.map((s) => s.label), ["SPEAKER_00", "SPEAKER_01"], "unnamed: the older Eneo would refuse it");
  const named = withSplit.map((r) => (r.label === "SPEAKER_05" ? { ...r, name: "Sara Holm" } : r));
  assert.deepEqual(buildEditedMapping(named).speakers.map((s) => [s.label, s.name]), [["SPEAKER_00", "Anna Berg"], ["SPEAKER_01", null], ["SPEAKER_05", "Sara Holm"]]);
  // Until Eneo names split labels, its refusal says which name to take away.
  assert.match(namingRefusal(new ApiError(422, "x", null, "typed_io_validation_failed"), named), /delats upp i granskningen \(Talare 6\)/);
  assert.doesNotMatch(namingRefusal(new ApiError(422, "x", null, "typed_io_validation_failed"), rows), /delats upp/);
});

test("speaker names with spaces and punctuation produce valid unique option IDs, in a list that floats over the page", async () => {
  const { createElement } = await import("react");
  const { NameCombobox } = await import("../components/NameCombobox");
  const view = await mount(
    createElement(NameCombobox, {
      value: null, options: ["Anna Andersson", "Bo / Carl", "none", "add"], onChange: () => undefined, label: "Namn för Talare 1",
      placeholder: "Välj eller skriv ett namn", noneLabel: "Ingen (behåll etiketten)",
    }),
  );
  const input = view.container.querySelector("input")!;
  await view.act(async () => input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const list = document.querySelector('[role="listbox"][aria-label="Förslag: Namn för Talare 1"]');
  assert.ok(list, "the list opens");
  assert.ok(list!.closest("[popover]"), "a popover of the top layer, so no scrolling body cuts it off");
  const ids = [...list!.querySelectorAll('[role="option"]')].map((option) => option.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => !/\s/.test(id)));
  assert.equal(input.getAttribute("aria-controls"), list!.id);
});

test("the flow's unsure proposal says so, and its evidence is one Varför? away", async () => {
  const proposals = [
    { ...row("SPEAKER_00", "Anna Berg", 12), confidence: "medium" as const, evidence: "Anna, du är på plats" },
    { ...row("SPEAKER_01", "Erik Lund", 9), confidence: "high" as const, evidence: "" },
  ];
  const { view, field } = await dialog({ rows: proposals, proposals });
  const rowOf = (label: string) => field(label).closest("li")!;
  assert.match(rowOf("Talare 1").textContent ?? "", /Osäkert förslag/, "medium confidence is marked");
  assert.match(computeAccessibleDescription(field("Talare 1")), /Osäkert förslag/, "and the field says it to a screen reader");
  assert.doesNotMatch(rowOf("Talare 2").textContent ?? "", /Osäkert förslag/, "a sure proposal is not");
  const why = button(rowOf("Talare 1"), "Varför?")!;
  assert.equal(why.getAttribute("aria-expanded"), "false", "the evidence waits behind Varför?");
  await view.act(async () => why.click());
  assert.equal(why.getAttribute("aria-expanded"), "true");
  assert.match(rowOf("Talare 1").textContent ?? "", /Anna, du är på plats/);
  assert.ok(!button(rowOf("Talare 2"), "Varför?"), "no Varför? without evidence");
  // Once someone types another name, it is no longer the flow's guess.
  await view.act(async () => type(field("Talare 1"), "Sara Holm"));
  assert.doesNotMatch(rowOf("Talare 1").textContent ?? "", /Osäkert förslag/);
});

test("Esc and Stäng only close, with the typed names there when the dialog opens again; Avbryt throws them away", async (t) => {
  // JD-02: one click beside the dialog, to look at the transcript, lost every typed name. Avbryt says what it does.
  t.after(() => window.sessionStorage.clear());
  const draftKey = { ownerId: "user-1", name: "names:run-1:cp-3" };
  const { view, trigger, field } = await dialog({ draftKey });
  const before = field("Talare 2").value;
  const shut = () => !document.querySelector("dialog[open]");
  const escape = (target: Element) => view.act(async () => target.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await view.act(async () => type(field("Talare 2"), "Bertil Eklund"));
  await view.act(async () => button(document.body, "Stäng")!.click());
  assert.ok(shut(), "Stäng closes");
  await view.act(async () => trigger.click());
  assert.equal(field("Talare 2").value, "Bertil Eklund", "kept through Stäng");
  await escape(field("Talare 2"));
  assert.ok(shut(), "Esc closes");
  await view.act(async () => trigger.click());
  assert.equal(field("Talare 2").value, "Bertil Eklund", "kept through Esc");
  await view.act(async () => button(document.body, "Avbryt")!.click());
  assert.ok(shut(), "Avbryt closes");
  await view.act(async () => trigger.click());
  assert.equal(field("Talare 2").value, before, "thrown away by Avbryt: the dialog opens as it was");
});

test("names typed but not saved come back after a reload, in the open dialog, until Avbryt; Spara namnen ends them", async (t) => {
  t.after(() => window.sessionStorage.clear());
  const draftKey = { ownerId: "user-1", name: "names:run-1:cp-1" };
  const first = await dialog({ draftKey });
  await first.view.act(async () => type(first.field("Talare 2"), "Erik Lund"));
  await first.view.unmount(); // the page reloaded before Spara namnen

  const reloaded = async () => {
    const { createElement } = await import("react");
    const { SpeakerNamingDialog } = await import("../components/SpeakerNamingDialog");
    return mountInProviders(
      createElement(SpeakerNamingDialog, {
        rows,
        participants: [],
        passages: () => 1,
        quote: () => null,
        onSave: async () => null,
        draftKey,
        children: createElement("button", { type: "button" }, "Namnge talarna"),
      }),
    );
  };
  const field = (label: string) => fieldNamed(`Vem är ${label}?`);
  const again = await reloaded();
  assert.equal(field("Talare 2")?.value, "Erik Lund", "open again, with the name typed before");
  assert.equal(field("Talare 1")?.value, "Anna Berg");
  await again.act(async () => button(document.body, "Avbryt")!.click());
  await again.unmount();
  const cancelled = await reloaded();
  assert.equal(field("Talare 2"), null, "Avbryt threw the draft away: after a reload the dialog does not open by itself");
  await cancelled.unmount();

  const typed = await dialog({ draftKey });
  await typed.view.act(async () => type(typed.field("Talare 2"), "Sara Holm"));
  await typed.view.act(async () => button(document.body, "Spara namnen")!.click());
  await typed.view.unmount();
  const saved = await reloaded();
  assert.equal(field("Talare 2"), null, "saved names are the review's, not a draft");
  await saved.unmount();
});

test("a name removed but not saved stays removed after a reload", async (t) => {
  t.after(() => window.sessionStorage.clear());
  const draftKey = { ownerId: "user-1", name: "names:run-1:cp-2" };
  const first = await dialog({ draftKey });
  await first.view.act(async () => type(first.field("Talare 1"), "")); // Anna Berg taken away
  await first.view.unmount();
  const { createElement } = await import("react");
  const { SpeakerNamingDialog } = await import("../components/SpeakerNamingDialog");
  const again = await mountInProviders(
    createElement(SpeakerNamingDialog, {
      rows,
      participants: [],
      passages: () => 1,
      quote: () => null,
      onSave: async () => null,
      draftKey,
      children: createElement("button", { type: "button" }, "Namnge talarna"),
    }),
  );
  const field = fieldNamed("Vem är Talare 1?");
  assert.equal(field?.value, "", "not the name the review had");
  await again.unmount();
});

test("once the pause is approved the dialog shows the saved names read-only, and its one action is Stäng", async () => {
  const { view, field, saved } = await dialog({ decided: true });
  const content = document.querySelector("dialog[open]")!;
  assert.match(content.textContent ?? "", /Namnen är redan sparade\./);
  assert.equal(field("Talare 1").value, "Anna Berg");
  assert.ok(field("Talare 1").disabled && field("Talare 2").disabled, "nothing to change any more");
  // Booleans: a failed comparison of a DOM node makes node print it, which takes minutes under jsdom.
  assert.ok(!button(document.body, "Spara namnen") && !button(document.body, "Avbryt"), "nothing to save or cancel");
  assert.ok(!button(document.body, "Fortsätt"), "the page's Fortsätt goes on, not the dialog");
  // The footer's Stäng, after the header's own.
  assert.deepEqual(footerActions(1), [["Stäng", "secondary"]]);
  await view.act(async () => [...content.querySelectorAll("button")].at(-1)!.click());
  assert.ok(!document.querySelector("dialog[open]"), "closed");
  assert.equal(saved.length, 0);
});

test("while the login has ended the dialog is closed, and it is back with its typed names after the new login", async (t) => {
  // A native dialog stays above the page's cover (a modal's inertness is its own), so the dialog follows the login.
  const { loginState } = await import("./login-state");
  const anna = { id: "user-1", email: "anna@example.se", username: "Anna Berg" };
  const end = loginState.begin(anna);
  t.after(end);
  const { view, trigger, field, listened } = await dialog();
  await view.act(async () => type(field("Talare 2"), "Erik Lund"));
  await view.act(async () => loginState.ended());
  assert.ok(!document.querySelector("dialog[open]"), "closed while the login is ended");
  assert.equal(document.querySelector("dialog[open] input"), null, "its fields leave with it");
  assert.deepEqual(listened, [], "nothing plays because of it");
  await view.act(async () => loginState.observe({ authenticated: true, user: anna, session_ends_in: 8 * 3600 }));
  assert.ok(document.querySelector("dialog[open]"), "back after the new login");
  assert.equal(field("Talare 2").value, "Erik Lund", "with the typed name");
  assert.ok(trigger.isConnected);
});

/**
 * The part of the window a phone's keyboard leaves visible (window.visualViewport), moved as the browser moves it, in a
 * window whose layout is as tall as jsdom's window (jsdom lays nothing out, so its clientHeight is 0).
 */
function visualViewport(t: import("node:test").TestContext) {
  const listeners = new Set<() => void>();
  const viewport = { height: window.innerHeight, offsetTop: 0, addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) };
  Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: window.innerHeight, configurable: true });
  t.after(() => {
    Reflect.deleteProperty(window, "visualViewport");
    Reflect.deleteProperty(document.documentElement, "clientHeight");
  });
  const move = (height: number, offsetTop: number) => {
    Object.assign(viewport, { height, offsetTop });
    listeners.forEach((listener) => listener());
  };
  return move;
}
const dialogElement = () => document.querySelector<HTMLDialogElement>("dialog[open]")!;

test("the dialog follows the part of the screen the phone's keyboard leaves: its height, and its top where the browser moves it", async (t) => {
  const move = visualViewport(t);
  const { view } = await dialog();
  assert.match(dialogElement().getAttribute("style") ?? "", new RegExp(`calc\\(${window.innerHeight}px`), "the dialog starts at the screen's height");
  assert.equal(dialogElement().classList.contains("atVisibleTop"), false, "in the middle of the window while all of it is visible");
  // The keyboard opens, and the browser moves the visible part down to keep the field in sight.
  await view.act(async () => move(420, 120));
  assert.match(dialogElement().getAttribute("style") ?? "", /calc\(420px/, "and keeps above the keyboard");
  assert.ok(dialogElement().classList.contains("atVisibleTop"), "at the top of the visible part");
  assert.equal(dialogElement().style.getPropertyValue("--visible-top"), "120px");
});

test("on a phone held upright the whole-screen dialog is as tall as what the keyboard leaves, so the focused field, the title and Spara namnen stay in sight", async (t) => {
  // Below 480 px the dialog takes the whole screen.
  const real = window.matchMedia;
  window.matchMedia = ((query: string) => ({ ...real(query), matches: query === "(max-width: 479.98px)" })) as typeof window.matchMedia;
  t.after(() => void (window.matchMedia = real));
  const move = visualViewport(t);
  const scrolled: { name: string; height: string }[] = [];
  const original = window.Element.prototype.scrollIntoView;
  window.Element.prototype.scrollIntoView = function (this: Element) {
    if (this instanceof window.HTMLInputElement) scrolled.push({ name: computeAccessibleName(this), height: dialogElement().style.height });
  };
  t.after(() => void (window.Element.prototype.scrollIntoView = original));
  const { view, field } = await dialog();
  assert.equal(dialogElement().style.height, "", "the whole screen while all of it is visible");
  // "Byt namn på Talare 2": the focus is in the lower speaker's field, and the keyboard covers all under 369 px.
  await view.act(async () => field("Talare 2").focus());
  scrolled.length = 0;
  await view.act(async () => move(369, 0));
  assert.deepEqual([dialogElement().style.top, dialogElement().style.height, dialogElement().style.maxHeight], ["0px", "369px", "369px"]);
  assert.deepEqual(scrolled, [{ name: "Vem är Talare 2?", height: "369px" }], "the field is brought into the dialog's view once the dialog is that tall");
  // The browser moves the visible part down: the dialog's title goes with it.
  await view.act(async () => move(369, 171));
  assert.equal(dialogElement().style.top, "171px");
  // The keyboard closes.
  await view.act(async () => move(window.innerHeight, 0));
  assert.deepEqual([dialogElement().style.top, dialogElement().style.height], ["", ""]);
  // Safari can report the window's height (innerHeight) as the part still visible, while the layout is as tall as ever.
  const inner = Object.getOwnPropertyDescriptor(window, "innerHeight");
  Object.defineProperty(window, "innerHeight", { value: 369, configurable: true });
  t.after(() => void (inner ? Object.defineProperty(window, "innerHeight", inner) : Reflect.deleteProperty(window, "innerHeight")));
  await view.act(async () => move(369, 303));
  assert.deepEqual([dialogElement().style.top, dialogElement().style.height], ["303px", "369px"], "it follows all the same");
});

test("with the keyboard open a name list ends where the dialog, and so the visible part, does: its last rows scroll into reach instead of lying under the keyboard", async (t) => {
  const move = visualViewport(t);
  // The name field ends at 311 px; the dialog at the window's end until it has followed the keyboard.
  let dialogEnd = window.innerHeight;
  const dialogs = window.HTMLDialogElement.prototype;
  const boxes = window.HTMLDivElement.prototype;
  dialogs.getBoundingClientRect = () => ({ top: 0, bottom: dialogEnd }) as DOMRect;
  boxes.getBoundingClientRect = () => ({ top: 0, bottom: 311 }) as DOMRect;
  // The dialog's size, watched: Chrome draws it at the keyboard's height a frame after the keyboard's own event.
  const resized: ((entries: []) => void)[] = [];
  const watcher = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback: (entries: []) => void) {
      resized.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  t.after(() => {
    Reflect.deleteProperty(dialogs, "getBoundingClientRect");
    Reflect.deleteProperty(boxes, "getBoundingClientRect");
    globalThis.ResizeObserver = watcher;
  });
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const { view, field } = await dialog();
  await view.act(async () => {
    field("Talare 2").click();
    move(396, 0);
    await frame();
  });
  const list = () => document.querySelector<HTMLElement>('[aria-label="Förslag: Vem är Talare 2?"]')!.style.maxHeight;
  // The dialog follows the keyboard: it ends at 396 px, where the keyboard starts.
  dialogEnd = 396;
  await view.act(async () => {
    resized.forEach((callback) => callback([]));
    await frame();
  });
  assert.equal(list(), "73px", "from under the field to the dialog's end, less a little room");
  await view.act(async () => {
    move(window.innerHeight, 0);
    await frame();
  });
  assert.equal(list(), "", "the keyboard closed: the list is as long as it is");
});

test("with too little left visible to follow (a phone on its side with the keyboard open), the dialog keeps its size and the browser pans to the field", async (t) => {
  const move = visualViewport(t);
  const { view } = await dialog();
  await view.act(async () => move(52, 228));
  assert.doesNotMatch(dialogElement().getAttribute("style") ?? "", /52px/, "never shrunk to what 52 px leaves");
  assert.equal(dialogElement().classList.contains("atVisibleTop"), false);
});

test("a phone on its side: where the browser leaves the field the focus was put in under the keyboard (Byt namn på, in Safari), the dialog moves up until the field is above it, and back when the keyboard closes", async (t) => {
  const move = visualViewport(t);
  const { createRef } = await import("react");
  const handle = createRef<import("../components/SpeakerNamingDialog").SpeakerNamingHandle>();
  const { view, field } = await dialog({ ref: handle });
  // The lower speaker's field ends at 173 px, wherever the dialog has moved it.
  const moved = () => -parseFloat(dialogElement().style.translate.split(" ")[1] ?? "0") || 0;
  field("Talare 2").getBoundingClientRect = () => ({ top: 147 - moved(), bottom: 173 - moved() }) as DOMRect;
  // "Byt namn på Talare 2" puts the focus in that field.
  await view.act(async () => handle.current!.open("SPEAKER_01", null));
  assert.equal(document.activeElement, field("Talare 2"));
  // The keyboard leaves 36 px, and the browser does not move the visible part to the field.
  await view.act(async () => move(36, 0));
  assert.equal(dialogElement().style.translate, "0 -153px", "the field ends a spacing above the keyboard");
  assert.doesNotMatch(dialogElement().getAttribute("style") ?? "", /36px/, "the dialog keeps its size");
  // Moved, the field stays where it is as the keyboard settles.
  await view.act(async () => move(36, 0));
  assert.equal(dialogElement().style.translate, "0 -153px");
  // The keyboard closes.
  await view.act(async () => move(window.innerHeight, 0));
  assert.equal(dialogElement().style.translate, "");
  // A tapped field: the browser moves the visible part to it itself, a moment after the keyboard's first resize, so the
  // dialog stays where it is (moved as well, the field would go off the top).
  await view.act(async () => field("Talare 1").focus());
  await view.act(async () => field("Talare 2").focus());
  await view.act(async () => move(36, 0));
  assert.equal(dialogElement().style.translate, "");
  await view.act(async () => move(36, 140));
  assert.equal(dialogElement().style.translate, "");
});

test("with no storage to keep drafts in (a private window), the dialog works and keeps nothing", async (t) => {
  const real = Object.getOwnPropertyDescriptor(window, "sessionStorage")!;
  Object.defineProperty(window, "sessionStorage", { get: () => { throw new Error("blocked"); }, configurable: true });
  t.after(() => void Object.defineProperty(window, "sessionStorage", real));
  const { view, field, saved } = await dialog({ draftKey: { ownerId: "user-1", name: "names:run-1:cp-9" } });
  await view.act(async () => type(field("Talare 2"), "Erik Lund"));
  assert.equal(field("Talare 2").value, "Erik Lund", "typing works");
  await view.act(async () => button(document.body, "Spara namnen")!.click());
  assert.deepEqual(saved[0].map((r) => r.name), ["Anna Berg", "Erik Lund"]);
});

test("names kept through a reload come back only as a list of speakers with their names: any other shape is dropped from the storage and opens nothing", async (t) => {
  t.after(() => window.sessionStorage.clear());
  const { createElement } = await import("react");
  const { SpeakerNamingDialog, hasNamesDraft } = await import("../components/SpeakerNamingDialog");
  const draftKey = { ownerId: "user-1", name: "names:run-1:cp-5" };
  const key = `tal-till-text:draft:${draftKey.ownerId}:${draftKey.name}`;
  const reloaded = () =>
    mountInProviders(
      createElement(SpeakerNamingDialog, {
        rows,
        participants: [],
        passages: () => 1,
        quote: () => null,
        onSave: async () => null,
        draftKey,
        children: createElement("button", { type: "button" }, "Namnge talarna"),
      }),
    );
  for (const [what, raw] of [
    ["an object where a list is kept", "{}"],
    ["null", "null"],
    ["a list of the wrong things", '[1, {"label": 5}]'],
    ["rows without a name", '[{"label": "SPEAKER_01"}]'],
    ["a name that is a number", '[{"label": "SPEAKER_01", "name": 5}]'],
  ]) {
    window.sessionStorage.setItem(key, raw);
    assert.equal(hasNamesDraft(draftKey), false, `${what} is no draft`);
    assert.equal(window.sessionStorage.getItem(key), null, `${what} is removed, not left to fail again`);
    window.sessionStorage.setItem(key, raw);
    const view = await reloaded();
    assert.ok(!document.querySelector("dialog[open]"), `${what}: the dialog does not open by itself`);
    assert.equal(window.sessionStorage.getItem(key), null, `${what} is removed`);
    await view.unmount();
  }
  window.sessionStorage.setItem(key, JSON.stringify([row("SPEAKER_01", "Erik Lund", 9)]));
  assert.equal(hasNamesDraft(draftKey), true, "names of the right shape are a draft");
  const view = await reloaded();
  assert.equal(fieldNamed("Vem är Talare 2?")?.value, "Erik Lund", "and open the dialog with them");
  assert.equal(fieldNamed("Vem är Talare 1?")?.value, "Anna Berg", "a speaker the draft has no row for keeps the review's name");
  await view.unmount();
});

test("a run started without participants offers the names this person gave before, and a save remembers the names given", async (t) => {
  const key = "tal-till-text:user-1:recent-names";
  t.after(() => window.localStorage.removeItem(key));
  window.localStorage.setItem(key, JSON.stringify(["Karin Ek", "Agne Lind"]));
  const offered = (label: string) =>
    [...document.querySelectorAll<HTMLElement>(`[aria-label="Förslag: Vem är ${label}?"] [role="option"]`)].map((o) => o.textContent);

  const withParticipants = await dialog({ draftKey: { ownerId: "user-1", name: "names:run-2" } });
  await withParticipants.view.act(async () => withParticipants.field("Talare 2").click());
  assert.ok(!offered("Talare 2").includes("Karin Ek"), "the run's own participants, not the names of other meetings");
  await withParticipants.view.unmount();

  const without = await dialog({ participants: [], draftKey: { ownerId: "user-1", name: "names:run-3" } });
  await without.view.act(async () => without.field("Talare 2").click());
  assert.ok(offered("Talare 2").includes("Karin Ek") && offered("Talare 2").includes("Agne Lind"), "the names given before");
  assert.ok(offered("Talare 2").some((name) => name?.startsWith("Anna Berg")), "and the names in the dialog");
  await without.view.act(async () => type(without.field("Talare 2"), "Sara Holm"));
  await without.view.act(async () => button(document.body, "Spara namnen")!.click());
  const remembered = JSON.parse(window.localStorage.getItem(key) ?? "[]");
  assert.deepEqual(remembered.slice(0, 2).sort(), ["Anna Berg", "Sara Holm"], "the names given, first");
  assert.ok(remembered.includes("Karin Ek"), "the earlier ones kept after them");
});

test("a refused save remembers no names", async (t) => {
  const key = "tal-till-text:user-1:recent-names";
  t.after(() => window.localStorage.removeItem(key));
  const view = await dialog({ participants: [], draftKey: { ownerId: "user-1", name: "names:run-4" }, onSave: async () => "Namnen kunde inte sparas." });
  await view.view.act(async () => type(view.field("Talare 2"), "Sara Holm"));
  await view.view.act(async () => button(document.body, "Spara namnen")!.click());
  assert.equal(window.localStorage.getItem(key), null);
});
