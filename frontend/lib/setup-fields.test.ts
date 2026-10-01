import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement, useState } from "react";
import { button, cleanup, installDom, mount, type } from "./test-dom";

installDom();
afterEach(cleanup);

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** Names in a ParticipantsInput that keeps its own list, as the form does, and what it reported as added. */
async function mountNames(names: string[] = [], suggestions: string[] = []) {
  const { ParticipantsInput } = await import("../components/flow/ParticipantsInput");
  const { ModuleProviders } = await import("@/kit/ModuleProviders");
  const { ThemeProvider } = await import("next-themes");
  const added: string[][] = [];
  function Field() {
    const [list, setList] = useState(names);
    return createElement(ParticipantsInput, { label: "Deltagare", name: "namn", names: list, onChange: setList, suggestions, onAdded: (fresh: string[]) => added.push(fresh) });
  }
  // In the page's providers, so the design system's own words (the remove buttons') are Swedish as they are there.
  const view = await mount(createElement(ThemeProvider, { attribute: "class", children: createElement(ModuleProviders, { children: createElement(Field) }) }));
  const input = () => view.container.querySelector<HTMLInputElement>('[data-detail-field="namn"]')!;
  const shown = () => [...view.container.querySelectorAll("ul[aria-label='Tillagda namn'] li")].map((li) => li.textContent);
  return { view, input, shown, added };
}

/** A paste into the field, as the browser gives it. */
function paste(field: HTMLElement, text: string) {
  const event = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  field.dispatchEvent(event);
  return event;
}

test("participants: a pasted list is split on commas, semicolons and line breaks, and a duplicate in another case is not added twice", async () => {
  const { view, input, shown, added } = await mountNames(["Anna Berg"]);
  const event = paste(input(), "Erik Lund, anna berg;\nSara Holm");
  await view.act(async () => {});
  assert.equal(event.defaultPrevented, true, "the list is the field's to split");
  assert.deepEqual(shown(), ["Anna Berg", "Erik Lund", "Sara Holm"], "in order, the existing one kept as it was written");
  assert.deepEqual(added, [["Erik Lund", "Sara Holm"]], "only what is new is remembered");
  assert.equal(input().value, "", "nothing left in the field");
});

test("participants: a paste with no separator is left to the browser, and Enter adds what was typed", async () => {
  const { view, input, shown } = await mountNames();
  const event = paste(input(), "Sara Holm");
  assert.equal(event.defaultPrevented, false, "one name pastes as text");
  await view.act(async () => type(input(), "Sara Holm"));
  await view.act(async () => input().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  assert.deepEqual(shown(), ["Sara Holm"]);
});

test("participants: picking one of the earlier names from the browser's suggestions adds it at once", async () => {
  const { view, input, shown } = await mountNames([], ["Sara Holm"]);
  await view.act(async () => {
    const field = input();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(field, "Sara Holm");
    field.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }));
  });
  assert.deepEqual(shown(), ["Sara Holm"]);
  // Typing the same letters is not a pick: it waits for Enter, a comma or leaving the field.
  await view.act(async () => type(input(), "Sara"));
  assert.deepEqual(shown(), ["Sara Holm"]);
});

test("participants: a comma adds what came before it, and Backspace in the empty field takes the last name back", async () => {
  const { view, input, shown } = await mountNames(["Anna Berg"]);
  await view.act(async () => type(input(), "Erik Lund, Sa"));
  assert.deepEqual(shown(), ["Anna Berg", "Erik Lund"]);
  assert.equal(input().value, "Sa", "what follows the comma stays to be finished");
  await view.act(async () => type(input(), ""));
  await view.act(async () => input().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true })));
  assert.deepEqual(shown(), ["Anna Berg"]);
});

test("participants: a name's remove button takes it away and the focus goes back to the field", async () => {
  const { view, input, shown } = await mountNames(["Anna Berg", "Erik Lund"]);
  await view.act(async () => button(view.container, "Ta bort Anna Berg")!.click());
  assert.deepEqual(shown(), ["Erik Lund"]);
  assert.equal(document.activeElement, input());
});

test("a missing required detail takes focus after the next paint: a text, a choice and a list alike", async () => {
  const { DetailsForm, createDocument } = await import("../components/flow/DetailsForm");
  const fields = [
    { name: "arende", label: "Ärende", type: "text", required: true },
    { name: "typ", label: "Mötestyp", type: "select", options: ["Nämnd", "Styrelse"], required: true },
    { name: "deltagare", label: "Deltagare", type: "list", required: true },
  ];
  const view = await mount(createElement(DetailsForm, { fields, details: {}, invalid: [], onChange: () => {}, suggestions: [], onNamesAdded: () => {} }));
  for (const [name, selector] of [
    ["arende", "input"],
    ["typ", '[role="combobox"]'],
    ["deltagare", "input"],
  ]) {
    const session = { createDocument: async () => false, getSnapshot: () => ({ invalid: [name] }) };
    await createDocument(session as never);
    await settle(30);
    const control = view.container.querySelector<HTMLElement>(`[data-detail-field="${name}"]`)!;
    assert.ok(control.matches(selector), `${name}: found by its name`);
    assert.ok(document.activeElement === control, `${name}: focused`);
    (document.activeElement as HTMLElement).blur();
  }
});

test("a detail's controls: a long text has four lines, an unknown kind is a text field, a date shows the one it holds", async () => {
  const { DetailsForm } = await import("../components/flow/DetailsForm");
  const view = await mount(
    createElement(DetailsForm, {
      fields: [
        { name: "sammanfattning", label: "Sammanfattning", type: "long_text" },
        { name: "anteckning", label: "Anteckning", type: "textarea" },
        { name: "okand", label: "Okänd", type: "something-new" },
        { name: "datum", label: "Datum", type: "date" },
      ],
      details: { datum: "2026-09-24" },
      invalid: [],
      onChange: () => {},
      suggestions: [],
      onNamesAdded: () => {},
    }),
  );
  await view.act(async () => settle(100));
  for (const name of ["sammanfattning", "anteckning"]) {
    const area = view.container.querySelector<HTMLTextAreaElement>(`[data-detail-field="${name}"]`)!;
    assert.equal(area.tagName, "TEXTAREA");
    assert.equal(area.rows, 4);
  }
  const unknown = view.container.querySelector<HTMLInputElement>('[data-detail-field="okand"]')!;
  assert.equal(unknown.type, "text");
  const date = view.container.querySelector<HTMLElement>('[data-detail-field="datum"]');
  assert.ok(date, "the date field is there once its calendar has loaded");
  assert.match(date.textContent + (date.querySelector("input")?.value ?? ""), /2026|24/, "and shows the date it holds");
});

test("more earlier runs: focus goes to the first run the page added", async () => {
  const { EarlierRuns } = await import("../components/flow/EarlierRuns");
  const run = (id: string) => ({ id, flow_id: "flow-1", status: "completed", created_at: "2026-09-23T10:12:00Z" });
  function List() {
    const [runs, setRuns] = useState([run("run-1"), run("run-2")]);
    return createElement(EarlierRuns, {
      list: { runs, hasMore: true, loading: false, failed: null },
      onOpen: () => {},
      onMore: () => setRuns((current) => [...current, run("run-3"), run("run-4")]),
    });
  }
  const view = await mount(createElement(List));
  await view.act(async () => button(view.container, "Visa fler körningar")!.click());
  const opens = [...view.container.querySelectorAll<HTMLElement>("[data-open-run]")];
  assert.equal(opens.length, 4);
  assert.ok(document.activeElement === opens[2], "the first of the two that were added");
});

test("upload: a drag that holds no file is ignored, several files give the first, and the chooser is emptied so the same file can be chosen again", async () => {
  const { UploadPanel } = await import("../components/flow/UploadPanel");
  const chosen: string[] = [];
  const view = await mount(createElement(UploadPanel, { step: null, file: null, audio: false, inputRef: null, onChoose: (file: File) => chosen.push(file.name) }));
  const zone = view.container.querySelector<HTMLElement>("[data-drop-zone]")!;
  const drag = (type: string, types: string[], files: File[] = []) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types, files } });
    zone.dispatchEvent(event);
    return event;
  };
  assert.equal(drag("dragover", ["text/plain"]).defaultPrevented, false, "text dragged over is not a file");
  assert.equal(drag("dragover", ["Files"]).defaultPrevented, true, "a file may be dropped here");
  await view.act(async () => void drag("drop", ["Files"], [new File(["a"], "forst.md"), new File(["b"], "andra.md")]));
  assert.deepEqual(chosen, ["forst.md"], "the first one only");

  const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  assert.ok(input.hidden, "a real file input stays, out of sight");
  Object.defineProperty(input, "files", { value: [new File(["c"], "tredje.md")], configurable: true });
  Object.defineProperty(input, "value", { value: "C:\\fakepath\\tredje.md", writable: true, configurable: true });
  await view.act(async () => input.dispatchEvent(new window.Event("change", { bubbles: true })));
  assert.deepEqual(chosen, ["forst.md", "tredje.md"]);
  assert.equal(input.value, "", "emptied, so choosing the same file again still changes something");
});

test("the microphone: refused says so and offers another try, a gone device is said at the picker, and the test lets go when recording starts", async () => {
  const { MicrophoneCheck } = await import("../components/flow/MicrophoneCheck");
  const stopped: boolean[] = [];
  let outcome: "denied" | "granted" = "denied";
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      addEventListener() {},
      removeEventListener() {},
      enumerateDevices: async () => [{ kind: "audioinput", deviceId: "mac", label: "MacBook Pro-mikrofon", groupId: "g1" }],
      getUserMedia: async () => {
        if (outcome === "denied") throw new DOMException("no", "NotAllowedError");
        return { getTracks: () => [{ stop: () => stopped.push(true) }], getAudioTracks: () => [] };
      },
    },
  });
  // A remembered device that is no longer there.
  localStorage.setItem("tal till text:microphone", "gone");
  localStorage.setItem("tal-till-text:microphone", "gone");
  function Page() {
    const [active, setActive] = useState(true);
    return createElement("div", null, createElement(MicrophoneCheck, { active }), createElement("button", { id: "start", onClick: () => setActive(false) }, "Start"));
  }
  const view = await mount(createElement(Page));
  assert.match(view.container.textContent ?? "", /Den valda mikrofonen hittades inte\. Standard används\./);

  await view.act(async () => button(view.container, "Testa mikrofonen")!.click());
  await view.act(async () => settle(0));
  assert.match(view.container.textContent ?? "", /Appen fick inte använda mikrofonen\./);
  assert.ok(button(view.container, "Försök igen"), "another try");

  outcome = "granted";
  await view.act(async () => button(view.container, "Försök igen")!.click());
  await view.act(async () => settle(0));
  assert.ok(button(view.container, "Sluta testa"), "the test is running");
  await view.act(async () => view.container.querySelector<HTMLButtonElement>("#start")!.click());
  assert.ok(stopped.length > 0, "the test let go of the microphone when recording started");
  localStorage.clear();
});
