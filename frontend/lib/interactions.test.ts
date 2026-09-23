import assert from "node:assert/strict";
import test from "node:test";

import { installDom, type } from "./test-dom";

installDom();

async function mount(element: import("react").ReactElement) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    act,
    unmount: () => act(async () => root.unmount()).then(() => container.remove()),
  };
}

const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name) ?? null;

test("participants: moving from the field to Lägg till and on keeps the typed name", async () => {
  const { createElement } = await import("react");
  const { ParticipantsInput } = await import("../components/flow/ParticipantsInput");
  const changes: string[][] = [];
  const outside = document.createElement("button");
  document.body.append(outside);
  const view = await mount(
    createElement(ParticipantsInput, { id: "namn", names: [], onChange: (names: string[]) => changes.push(names), suggestions: [] }),
  );
  const field = view.container.querySelector<HTMLInputElement>("#namn")!;
  await view.act(async () => field.focus());
  await view.act(async () => type(field, "Anna Berg"));
  const add = button(view.container, "Lägg till")!;
  assert.ok(add, "Lägg till shows while a name is typed");
  // Tab to the button: not yet added, the button adds it.
  await view.act(async () => add.focus());
  assert.deepEqual(changes, []);
  // Tab on past it: the name is not lost.
  await view.act(async () => outside.focus());
  assert.deepEqual(changes, [["Anna Berg"]]);
  await view.unmount();
  outside.remove();
});

test("participants: Tab to Lägg till and Enter adds the name, and focus goes back to the field", async () => {
  const { createElement } = await import("react");
  const { ParticipantsInput } = await import("../components/flow/ParticipantsInput");
  const changes: string[][] = [];
  const view = await mount(
    createElement(ParticipantsInput, { id: "namn2", names: [], onChange: (names: string[]) => changes.push(names), suggestions: [] }),
  );
  const field = view.container.querySelector<HTMLInputElement>("#namn2")!;
  await view.act(async () => field.focus());
  await view.act(async () => type(field, "Erik Lund"));
  const add = button(view.container, "Lägg till")!;
  await view.act(async () => add.focus());
  await view.act(async () => add.click());
  assert.deepEqual(changes, [["Erik Lund"]], "added once");
  assert.equal(document.activeElement, field);
  await view.unmount();
});

async function mountEditableTranscript(onChange: (next: unknown) => void) {
  const { createElement } = await import("react");
  const { TranscriptPlayer } = await import("../components/TranscriptPlayer");
  const view = await mount(
    createElement(TranscriptPlayer, {
      segments: [
        { fileIndex: 0, start: 0, end: 2, speaker: "SPEAKER_00", text: "Välkomna till mötet." },
        { fileIndex: 0, start: 2, end: 4, speaker: "SPEAKER_01", text: "Tack, vi börjar." },
      ],
      fileCount: 0,
      audioSrcFor: () => "",
      speakerNames: {},
      textFallback: "",
      reviewEnabled: false,
      editable: true,
      corrections: { occurrences: [], speaker_edits: [], revision: null },
      onCorrectionsChange: onChange,
    }),
  );
  await view.act(async () => button(view.container, "Rätta repliken")!.click());
  const editor = view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Rätta repliken"]')!;
  assert.ok(editor, "the line editor is open");
  await view.act(async () => type(editor, "Välkomna allihop."));
  return { view, editor };
}

test("transcript: Tab to Avbryt and activate it leaves the text as it was", async () => {
  const changes: unknown[] = [];
  const { view } = await mountEditableTranscript((next) => changes.push(next));
  const cancel = button(view.container, "Avbryt")!;
  await view.act(async () => cancel.focus());
  assert.deepEqual(changes, [], "moving to the editor's own buttons saves nothing");
  assert.ok(button(view.container, "Avbryt"), "the editor stays open");
  await view.act(async () => cancel.click());
  assert.deepEqual(changes, []);
  assert.equal(view.container.querySelector("textarea"), null, "closed, unchanged");
  await view.unmount();
});

test("transcript: Tab to Spara and activate it saves once; leaving the editor saves too", async () => {
  const saved: unknown[] = [];
  const { view } = await mountEditableTranscript((next) => saved.push(next));
  const save = button(view.container, "Spara")!;
  await view.act(async () => save.focus());
  assert.deepEqual(saved, []);
  await view.act(async () => save.click());
  assert.equal(saved.length, 1);
  await view.unmount();

  const left: unknown[] = [];
  const outside = document.createElement("button");
  document.body.append(outside);
  const again = await mountEditableTranscript((next) => left.push(next));
  await again.view.act(async () => outside.focus());
  assert.equal(left.length, 1, "focus leaving the whole editor saves the edit");
  await again.view.unmount();
  outside.remove();
});

test("a choice field keeps every option Eneo sends, also one that reads like 'no choice'", async () => {
  const { createElement } = await import("react");
  const { DetailsForm } = await import("../components/flow/DetailsForm");
  const changes: [string, unknown][] = [];
  const mountWith = (value: string) =>
    mount(
      createElement(DetailsForm, {
        fields: [{ name: "svar", label: "Svar", type: "select", options: ["inget-val", "Ja", "opt:0"], required: false }],
        details: { svar: value },
        invalid: [],
        onChange: (name: string, next: unknown) => changes.push([name, next]),
        suggestions: [],
        onNamesAdded: () => {},
      }),
    );
  const open = async (view: Awaited<ReturnType<typeof mountWith>>) => {
    const trigger = view.container.querySelector<HTMLButtonElement>("#detalj-svar")!;
    await view.act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  };

  const chosen = await mountWith("inget-val");
  assert.equal(chosen.container.querySelector("#detalj-svar")?.textContent?.trim(), "inget-val", "the chosen option, not 'no choice'");
  assert.deepEqual((await open(chosen)).map((option) => option.textContent?.trim()), ["Inget val", "inget-val", "Ja", "opt:0"]);
  await chosen.unmount();

  // Choosing each one hands back its own value, and "Inget val" the empty one.
  for (const [start, label, expected] of [
    ["", "opt:0", "opt:0"],
    ["", "Ja", "Ja"],
    ["", "inget-val", "inget-val"],
    ["Ja", "Inget val", ""],
  ] as const) {
    const view = await mountWith(start);
    const option = (await open(view)).find((o) => o.textContent?.trim() === label)!;
    await view.act(async () => {
      option.focus();
      option.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    assert.deepEqual(changes.at(-1), ["svar", expected], label);
    await view.unmount();
  }
});

test("the microphone test uses the device recording will use, and shows it, also before the names are known", async () => {
  const { createElement } = await import("react");
  const { MicrophoneCheck } = await import("../components/flow/MicrophoneCheck");
  let allowed = false;
  const asked: MediaStreamConstraints[] = [];
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      addEventListener() {},
      removeEventListener() {},
      enumerateDevices: async () =>
        [
          ["default", "Standard – MacBook Pro-mikrofon", "g1"],
          ["mac", "MacBook Pro-mikrofon", "g1"],
          ["usb", "Jabra Speak 510", "g2"],
        ].map(([deviceId, label, groupId]) => ({
          kind: "audioinput",
          deviceId: allowed ? deviceId : "",
          label: allowed ? label : "",
          groupId,
        })),
      getUserMedia: async (constraints: MediaStreamConstraints) => {
        asked.push(constraints);
        allowed = true;
        return { getTracks: () => [{ stop() {} }], getAudioTracks: () => [] };
      },
    },
  });
  localStorage.setItem("tal-till-text:microphone", "usb");
  const view = await mount(createElement(MicrophoneCheck, { active: true }));
  const trigger = () => view.container.querySelector<HTMLButtonElement>('[role="combobox"]')!.textContent?.trim();
  assert.equal(trigger(), "Senast vald mikrofon", "the remembered choice, before the browser names it");

  await view.act(async () => button(view.container, "Testa mikrofonen")!.click());
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.deepEqual((asked[0].audio as MediaTrackConstraints).deviceId, { ideal: "usb" }, "as recording asks for it");
  assert.equal(trigger(), "Jabra Speak 510", "the device under test, by name");
  await view.unmount();
  localStorage.clear();
});
