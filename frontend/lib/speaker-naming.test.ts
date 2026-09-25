import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { ApiError } from "./api";
import { buildEditedMapping, namingRefusal, withSplitLabels, type SpeakerMappingRow } from "./speaker-mapping";
import { button, cleanup, installDom, mount, type } from "./test-dom";

installDom();
afterEach(cleanup);

const row = (label: string, name: string | null, lineCount = 3): SpeakerMappingRow => ({
  label, name, lineCount, samples: [], confidence: "medium", evidence: "",
});
const rows = [row("SPEAKER_00", "Anna Berg", 12), row("SPEAKER_01", null, 9)];

async function dialog(props: Record<string, unknown> = {}) {
  const { createElement } = await import("react");
  const { SpeakerNamingDialog } = await import("../components/SpeakerNamingDialog");
  const saved: SpeakerMappingRow[][] = [];
  const continued: SpeakerMappingRow[][] = [];
  const listened: string[] = [];
  const view = await mount(
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
      onSaveAndContinue: async (next: SpeakerMappingRow[]) => {
        continued.push(next);
        return null;
      },
      children: createElement("button", { type: "button" }, "Namnge talarna"),
      ...props,
    }),
  );
  const trigger = button(view.container, "Namnge talarna")!;
  await view.act(async () => trigger.click());
  const field = (label: string) => document.querySelector<HTMLInputElement>(`[role="dialog"] input[aria-label="Vem är ${label}?"]`)!;
  return { view, trigger, field, saved, continued, listened };
}

test("each speaker is a row: the mark, how many passages, what they say first, a sample and a name", async () => {
  const { view, field, listened } = await dialog();
  const content = document.querySelector('[role="dialog"]')!;
  assert.match(content.textContent ?? "", /Namnge talarna/);
  assert.match(content.textContent ?? "", /Talare 1 · 12 inlägg”Välkomna till mötet\.”/);
  assert.match(content.textContent ?? "", /Talare 2 · 9 inlägg”Första punkten gäller budgeten\.”/);
  assert.equal(field("Talare 1").value, "Anna Berg");
  assert.equal(field("Talare 2").value, "", "no name is assumed for the other speaker");
  await view.act(async () => button(document.body, "Lyssna på exempel: Talare 2")!.click());
  assert.deepEqual(listened, ["SPEAKER_01"]);
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
  await view.act(async () => button(document.body, "Spara")!.click());
  assert.deepEqual(saved.at(-1)?.map((r) => r.name), ["Anna Berg", "Erik Lund"]);
});

/** One name field on its own, holding what is chosen, driven by the keyboard. */
async function nameField(value: string | null, options: string[]) {
  const { createElement, useState } = await import("react");
  const { NameCombobox } = await import("../components/NameCombobox");
  function Field() {
    const [name, setName] = useState<string | null>(value);
    return createElement(NameCombobox, { value: name, options, onChange: setName, "aria-label": "Vem är Talare 2?" });
  }
  const view = await mount(createElement(Field));
  const input = view.container.querySelector("input")!;
  const key = (k: string) => view.act(async () => input.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true })));
  const option = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.startsWith(name))!;
  const marked = () => document.getElementById(input.getAttribute("aria-activedescendant") ?? "")?.textContent ?? null;
  return { view, input, key, option, marked };
}

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

test("inside the list, the row the keys are on is the selected one; the saved name keeps its check", async () => {
  const { view, input, key, option } = await nameField("Erik Lund", ["Anna Berg", "Erik Lund"]);
  await view.act(async () => input.focus());
  await key("ArrowUp");
  assert.equal(option("Anna Berg").getAttribute("aria-selected"), "true");
  assert.equal(option("Erik Lund").getAttribute("aria-selected"), "false");
  assert.ok(option("Erik Lund").querySelector(".lucide-check"), "the name in the field still shows its check");
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

test("Spara och fortsätt saves the names and lets the flow go on, in one action", async () => {
  const { view, field, saved, continued } = await dialog();
  await view.act(async () => type(field("Talare 2"), "  Erik Lund  "));
  await view.act(async () => button(document.body, "Spara och fortsätt")!.click());
  assert.deepEqual(continued.map((next) => next.map((r) => [r.label, r.name])), [[["SPEAKER_00", "Anna Berg"], ["SPEAKER_01", "Erik Lund"]]]);
  assert.equal(saved.length, 0, "not saved a second time on the side");
});

test("a refused Spara och fortsätt stays open, with the names kept and the reason", async () => {
  const { view, field } = await dialog({ onSaveAndContinue: async () => "Flödet kunde inte fortsätta. Försök igen." });
  await view.act(async () => type(field("Talare 2"), "Erik Lund"));
  await view.act(async () => button(document.body, "Spara och fortsätt")!.click());
  assert.ok(document.querySelector('[role="dialog"]'), "still open");
  assert.match(document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? "", /Flödet kunde inte fortsätta/);
  assert.equal(field("Talare 2").value, "Erik Lund");
});

test("Spara, for someone who stops here, saves trimmed names, closes and gives the focus back", async () => {
  const { view, trigger, field, saved, continued } = await dialog();
  await view.act(async () => type(field("Talare 2"), "  Erik Lund  "));
  await view.act(async () => button(document.body, "Spara")!.click());
  assert.equal(continued.length, 0);
  assert.deepEqual(saved[0].map((r) => [r.label, r.name]), [["SPEAKER_00", "Anna Berg"], ["SPEAKER_01", "Erik Lund"]]);
  assert.ok(!document.querySelector('[role="dialog"]'), "closed");
  // Radix hands the focus back after closing; wait a turn. Compare as a boolean: a failed
  // comparison of two DOM nodes makes node print them, which takes minutes under jsdom.
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.ok(document.activeElement === trigger, "focus back on the button that opened it");
});

test("a name with a line break or a tab is not saved, and says why", async () => {
  const { view, field, saved, continued } = await dialog();
  await view.act(async () => type(field("Talare 2"), "Erik\tLund"));
  await view.act(async () => button(document.body, "Spara och fortsätt")!.click());
  assert.equal(saved.length + continued.length, 0);
  assert.match(document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? "", /Ett namn är en rad/);
});

test("a refused save stays open with Eneo's reason", async () => {
  const { view, field } = await dialog({ onSave: async () => "Granskningen har ändrats sedan du laddade sidan." });
  await view.act(async () => type(field("Talare 2"), "Erik Lund"));
  await view.act(async () => button(document.body, "Spara")!.click());
  assert.ok(document.querySelector('[role="dialog"]'), "still open");
  assert.match(document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? "", /Granskningen har ändrats/);
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
      value: null, options: ["Anna Andersson", "Bo / Carl", "none", "add"], onChange: () => undefined, "aria-label": "Namn för Talare 1",
    }),
  );
  const input = view.container.querySelector("input")!;
  await view.act(async () => input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const list = document.querySelector('[role="listbox"][aria-label="Förslag: Namn för Talare 1"]');
  assert.ok(list, "the list opens");
  assert.ok(!view.container.contains(list), "outside the field's box, so no scrolling body cuts it off");
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
  assert.doesNotMatch(rowOf("Talare 2").textContent ?? "", /Osäkert förslag/, "a sure proposal is not");
  assert.doesNotMatch(rowOf("Talare 1").textContent ?? "", /du är på plats/, "the evidence waits behind Varför?");
  await view.act(async () => button(rowOf("Talare 1"), "Varför?")!.click());
  assert.match(rowOf("Talare 1").textContent ?? "", /Anna, du är på plats/);
  assert.ok(!button(rowOf("Talare 2"), "Varför?"), "no Varför? without evidence");
  // Once someone types another name, it is no longer the flow's guess.
  await view.act(async () => type(field("Talare 1"), "Sara Holm"));
  assert.doesNotMatch(rowOf("Talare 1").textContent ?? "", /Osäkert förslag/);
});

test("names typed but not saved come back after a reload, in the open dialog; Spara or Avbryt ends them", async (t) => {
  t.after(() => window.sessionStorage.clear());
  const draftKey = { ownerId: "user-1", name: "names:run-1:cp-1" };
  const first = await dialog({ draftKey });
  await first.view.act(async () => type(first.field("Talare 2"), "Erik Lund"));
  await first.view.unmount(); // the page reloaded before Spara

  const reloaded = async () => {
    const { createElement } = await import("react");
    const { SpeakerNamingDialog } = await import("../components/SpeakerNamingDialog");
    return mount(
      createElement(SpeakerNamingDialog, {
        rows,
        participants: [],
        passages: () => 1,
        quote: () => null,
        onSave: async () => null,
        onSaveAndContinue: async () => null,
        draftKey,
        children: createElement("button", { type: "button" }, "Namnge talarna"),
      }),
    );
  };
  const field = (label: string) => document.querySelector<HTMLInputElement>(`[role="dialog"] input[aria-label="Vem är ${label}?"]`);
  const again = await reloaded();
  assert.equal(field("Talare 2")?.value, "Erik Lund", "open again, with the name typed before");
  assert.equal(field("Talare 1")?.value, "Anna Berg");
  await again.act(async () => button(document.body, "Avbryt")!.click());
  await again.unmount();
  const cancelled = await reloaded();
  assert.equal(field("Talare 2"), null, "Avbryt threw the names away, as it did before");
  await cancelled.unmount();

  const typed = await dialog({ draftKey });
  await typed.view.act(async () => type(typed.field("Talare 2"), "Sara Holm"));
  await typed.view.act(async () => button(document.body, "Spara")!.click());
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
  const again = await mount(
    createElement(SpeakerNamingDialog, {
      rows,
      participants: [],
      passages: () => 1,
      quote: () => null,
      onSave: async () => null,
      onSaveAndContinue: async () => null,
      draftKey,
      children: createElement("button", { type: "button" }, "Namnge talarna"),
    }),
  );
  const field = document.querySelector<HTMLInputElement>('[role="dialog"] input[aria-label="Vem är Talare 1?"]');
  assert.equal(field?.value, "", "not the name the review had");
  await again.unmount();
});

test("once the pause is approved the dialog shows the saved names read-only, and its one action is Fortsätt", async () => {
  const { view, field, saved, continued } = await dialog({ decided: true });
  const content = document.querySelector('[role="dialog"]')!;
  assert.match(content.textContent ?? "", /Namnen är redan sparade\./);
  assert.equal(field("Talare 1").value, "Anna Berg");
  assert.ok(field("Talare 1").disabled && field("Talare 2").disabled, "nothing to change any more");
  assert.equal(button(document.body, "Spara"), null);
  assert.equal(button(document.body, "Spara och fortsätt"), null);
  await view.act(async () => button(document.body, "Fortsätt")!.click());
  assert.deepEqual(continued.map((next) => next.map((r) => [r.label, r.name])), [[["SPEAKER_00", "Anna Berg"], ["SPEAKER_01", null]]]);
  assert.equal(saved.length, 0);
});
