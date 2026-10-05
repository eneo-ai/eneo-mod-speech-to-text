import assert from "node:assert/strict";
import test from "node:test";

import { button, installDom, mount, type } from "./test-dom";
import { withRouter } from "./test-router";

installDom();

test("participants: moving from the field to Lägg till and on keeps the typed name", async () => {
  const { createElement } = await import("react");
  const { ParticipantsInput } = await import("../components/flow/ParticipantsInput");
  const changes: string[][] = [];
  const outside = document.createElement("button");
  document.body.append(outside);
  const view = await mount(
    createElement(ParticipantsInput, { label: "Deltagare", fieldName: "namn", names: [], onChange: (names: string[]) => changes.push(names), suggestions: [] }),
  );
  const field = view.container.querySelector<HTMLInputElement>('[data-detail-field="namn"]')!;
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
    createElement(ParticipantsInput, { label: "Deltagare", fieldName: "namn2", names: [], onChange: (names: string[]) => changes.push(names), suggestions: [] }),
  );
  const field = view.container.querySelector<HTMLInputElement>('[data-detail-field="namn2"]')!;
  await view.act(async () => field.focus());
  await view.act(async () => type(field, "Erik Lund"));
  const add = button(view.container, "Lägg till")!;
  await view.act(async () => add.focus());
  await view.act(async () => add.click());
  assert.deepEqual(changes, [["Erik Lund"]], "added once");
  assert.equal(document.activeElement, field);
  await view.unmount();
});

/** A participants field with a record of what it hands back, the browser's own typing and pasting done to its input. */
async function mountParticipants(suggestions: string[] = []) {
  const { createElement } = await import("react");
  const { ParticipantsInput } = await import("../components/flow/ParticipantsInput");
  const changes: string[][] = [];
  const view = await mount(
    createElement(ParticipantsInput, { label: "Deltagare", fieldName: "namn3", names: [], onChange: (names: string[]) => changes.push(names), suggestions }),
  );
  const field = view.container.querySelector<HTMLInputElement>('[data-detail-field="namn3"]')!;
  return { view, field, changes };
}

test("participants: a pasted list is split on commas, semicolons and line breaks, and one name without a separator is typed as usual", async () => {
  const { view, field, changes } = await mountParticipants();
  const paste = (text: string) => {
    const event = new window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
    field.dispatchEvent(event);
    return event.defaultPrevented;
  };
  await view.act(async () => field.focus());
  let prevented = true;
  await view.act(async () => {
    prevented = paste("Anna Berg");
  });
  assert.equal(prevented, false, "a single name is left for the field to take");
  assert.deepEqual(changes, []);
  await view.act(async () => void paste("Anna Berg, Erik Lund;Sara Holm\nanna berg"));
  // Added once each: a name already there, in another case, is not added again.
  assert.deepEqual(changes.at(-1), ["Anna Berg", "Erik Lund", "Sara Holm"]);
  await view.unmount();
});

test("participants: a name picked from the browser's suggestions is added at once, a typed one waits for its comma", async () => {
  const { view, field, changes } = await mountParticipants(["Sara Holm"]);
  const typeAs = (value: string, inputType: string) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType }));
  };
  await view.act(async () => typeAs("sara holm", "insertText"));
  assert.deepEqual(changes, [], "typed in full, it is still only text");
  await view.act(async () => typeAs("Sara Holm", "insertReplacementText"));
  assert.deepEqual(changes.at(-1), ["Sara Holm"], "picked from the list: added, as typed in the list");
  assert.equal(field.value, "");
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
  await view.act(async () => button(view.container, "Rätta repliken från 0:00")!.click());
  const { computeAccessibleName } = await import("dom-accessibility-api");
  const editor = [...view.container.querySelectorAll<HTMLTextAreaElement>("textarea")].find((area) => computeAccessibleName(area) === "Rätta repliken från 0:00")!;
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

test("transcript: closing a line's editor from inside it gives the focus back to that passage's Rätta", async () => {
  for (const close of ["Enter", "Escape", "Spara", "Avbryt"]) {
    const { view, editor } = await mountEditableTranscript(() => undefined);
    await view.act(async () => {
      if (close === "Enter" || close === "Escape") editor.dispatchEvent(new window.KeyboardEvent("keydown", { key: close, bubbles: true }));
      else {
        button(view.container, close)!.focus();
        button(view.container, close)!.click();
      }
    });
    assert.equal(view.container.querySelector("textarea"), null, `${close} closes the editor`);
    const focused = document.activeElement;
    assert.ok(focused === button(view.container, "Rätta repliken från 0:00"), `${close}: focus on ${focused?.tagName} "${focused?.textContent}"`);
    await view.unmount();
  }
  // Leaving the editor for another control keeps the focus there.
  const outside = document.createElement("button");
  document.body.append(outside);
  const { view } = await mountEditableTranscript(() => undefined);
  await view.act(async () => outside.focus());
  assert.ok(document.activeElement === outside);
  await view.unmount();
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
    const trigger = view.container.querySelector<HTMLButtonElement>('[data-detail-field="svar"]')!;
    await view.act(async () => trigger.click());
    return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  };

  const chosen = await mountWith("inget-val");
  assert.equal(chosen.container.querySelector('[data-detail-field="svar"]')?.textContent?.trim(), "inget-val", "the chosen option, not 'no choice'");
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
    await view.act(async () => option.click());
    assert.deepEqual(changes.at(-1), ["svar", expected], label);
    await view.unmount();
  }
});

test("a refused start puts focus on the first detail that blocks it, whatever kind of field it is", async () => {
  const { createElement } = await import("react");
  const { DetailsForm, createDocument } = await import("../components/flow/DetailsForm");
  const fields = [
    { name: "arende", label: "Ärende", type: "text", required: true },
    { name: "typ", label: "Mötestyp", type: "select", options: ["Nämnd", "Styrelse"], required: true },
    { name: "deltagare", label: "Deltagare", type: "list", required: true },
  ] as import("./api").FormField[];
  const view = await mount(
    createElement(DetailsForm, { fields, details: {}, invalid: [], onChange: () => {}, suggestions: [], onNamesAdded: () => {} }),
  );
  for (const [name, role] of [["arende", "INPUT"], ["typ", "BUTTON"], ["deltagare", "INPUT"]] as const) {
    const session = { createDocument: async () => false, getSnapshot: () => ({ invalid: [name] }) } as unknown as import("./flow-session").FlowSession;
    await view.act(async () => {
      await createDocument(session);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    assert.equal(document.activeElement?.tagName, role, name);
    assert.equal(document.activeElement?.closest("[data-detail-field], [role=group]")?.querySelector("[data-detail-field]")?.getAttribute("data-detail-field") ?? document.activeElement?.getAttribute("data-detail-field"), name);
  }
  await view.unmount();
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

/** A microphone the browser has, by what it answers: devices (named once allowed) and what asking for one does. */
function stubMicrophones(devices: [string, string][], getUserMedia: () => Promise<unknown>) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      addEventListener() {},
      removeEventListener() {},
      enumerateDevices: async () => devices.map(([deviceId, label]) => ({ kind: "audioinput", deviceId, label, groupId: deviceId })),
      getUserMedia,
    },
  });
}

/** A microphone stream whose tracks a test can look at. */
function listeningStream() {
  const track = { stopped: false, stop() { this.stopped = true; } };
  return { track, stream: { getTracks: () => [track], getAudioTracks: () => [] } };
}

test("a microphone the browser grants after Sluta testa is let go at once, not turned on again", async () => {
  const { createElement } = await import("react");
  const { MicrophoneCheck } = await import("../components/flow/MicrophoneCheck");
  const first = listeningStream();
  const late = listeningStream();
  const grants: Array<(stream: unknown) => void> = [];
  stubMicrophones([["usb", "Jabra Speak 510"]], () => new Promise((resolve) => grants.push(resolve)));
  const view = await mount(createElement(MicrophoneCheck, { active: true }));
  const settleAll = () => view.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

  await view.act(async () => button(view.container, "Testa mikrofonen")!.click()); // asks the browser...
  await view.act(async () => button(view.container, "Testa mikrofonen")!.click()); // ...and again, as when the device is changed
  assert.equal(grants.length, 2, "two requests are pending");
  await view.act(async () => grants[1](first.stream)); // the newer one answers first and is under test
  await settleAll();
  assert.ok(button(view.container, "Sluta testa"), "it is under test");

  await view.act(async () => button(view.container, "Sluta testa")!.click());
  assert.equal(first.track.stopped, true, "Sluta testa lets that one go");
  await view.act(async () => grants[0](late.stream)); // the older request, still pending, answers now
  await settleAll();
  assert.equal(late.track.stopped, true, "the one that arrives after it is let go at once");
  assert.ok(button(view.container, "Testa mikrofonen"), "and nothing is under test");
  assert.equal(button(view.container, "Sluta testa"), null);
  await view.unmount();
});

test("a microphone request that a newer one has replaced is let go when it arrives, and the newer one is the test", async () => {
  const { createElement } = await import("react");
  const { MicrophoneCheck } = await import("../components/flow/MicrophoneCheck");
  const older = listeningStream();
  const newer = listeningStream();
  const grants: Array<(stream: unknown) => void> = [];
  stubMicrophones([["usb", "Jabra Speak 510"]], () => new Promise((resolve) => grants.push(resolve)));
  const view = await mount(createElement(MicrophoneCheck, { active: true }));
  await view.act(async () => button(view.container, "Testa mikrofonen")!.click());
  await view.act(async () => button(view.container, "Testa mikrofonen")!.click());

  await view.act(async () => grants[1](newer.stream)); // the newer answers first
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  await view.act(async () => grants[0](older.stream)); // the older one, too late
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.equal(older.track.stopped, true, "the replaced request's microphone is let go");
  assert.equal(newer.track.stopped, false, "the test runs on the newer one");
  assert.ok(button(view.container, "Sluta testa"));
  await view.unmount();
  assert.equal(newer.track.stopped, true, "and the page going lets that go too");
});

test("a request that failed after Sluta testa says nothing", async () => {
  const { createElement } = await import("react");
  const { MicrophoneCheck } = await import("../components/flow/MicrophoneCheck");
  const first = listeningStream();
  const grants: Array<{ ok: (stream: unknown) => void; fail: (error: unknown) => void }> = [];
  stubMicrophones([["usb", "Jabra Speak 510"]], () => new Promise((ok, fail) => grants.push({ ok, fail })));
  const view = await mount(createElement(MicrophoneCheck, { active: true }));
  await view.act(async () => button(view.container, "Testa mikrofonen")!.click());
  await view.act(async () => button(view.container, "Testa mikrofonen")!.click());
  await view.act(async () => grants[1].ok(first.stream));
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  await view.act(async () => button(view.container, "Sluta testa")!.click());
  await view.act(async () => grants[0].fail(new DOMException("denied", "NotAllowedError")));
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.doesNotMatch(view.container.textContent ?? "", /Appen fick inte använda mikrofonen/, "a test that was ended has no error to show");
  await view.unmount();
});

test("a microphone the browser refuses is said with what to do, and Försök igen asks again", async () => {
  const { createElement } = await import("react");
  const { MicrophoneCheck } = await import("../components/flow/MicrophoneCheck");
  let asked = 0;
  stubMicrophones([], async () => {
    asked += 1;
    throw new DOMException("denied", "NotAllowedError");
  });
  const view = await mount(createElement(MicrophoneCheck, { active: true }));
  await view.act(async () => button(view.container, "Testa mikrofonen")!.click());
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.match(view.container.textContent ?? "", /Appen fick inte använda mikrofonen\.Tillåt mikrofonen i webbläsarens inställningar/);
  assert.equal(button(view.container, "Testa mikrofonen") !== null, true, "no test is running");
  await view.act(async () => button(view.container, "Försök igen")!.click());
  assert.equal(asked, 2);
  await view.unmount();
});

test("a remembered microphone that is gone falls back to Standard and says so", async () => {
  const { createElement } = await import("react");
  const { MicrophoneCheck } = await import("../components/flow/MicrophoneCheck");
  stubMicrophones(
    [["default", "Standard – Inbyggd mikrofon"], ["mac", "Inbyggd mikrofon"]],
    async () => ({ getTracks: () => [], getAudioTracks: () => [] }),
  );
  localStorage.setItem("tal-till-text:microphone", "gone");
  const view = await mount(createElement(MicrophoneCheck, { active: true }));
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.match(view.container.textContent ?? "", /Den valda mikrofonen hittades inte\. Standard används\./);
  await view.unmount();
  localStorage.clear();
});

test("the microphone test lets go of the microphone when recording starts", async () => {
  const { createElement, useState } = await import("react");
  const { MicrophoneCheck } = await import("../components/flow/MicrophoneCheck");
  let stopped = 0;
  stubMicrophones([["default", "Standard"]], async () => ({ getTracks: () => [{ stop: () => (stopped += 1) }], getAudioTracks: () => [] }));
  let setActive: (on: boolean) => void = () => {};
  function Page() {
    const [active, set] = useState(true);
    setActive = set;
    return createElement(MicrophoneCheck, { active });
  }
  const view = await mount(createElement(Page));
  await view.act(async () => button(view.container, "Testa mikrofonen")!.click());
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.ok(button(view.container, "Sluta testa"), "the test is running");
  assert.equal(stopped, 0);
  await view.act(async () => setActive(false));
  assert.equal(stopped, 1, "the recording gets the microphone");
  assert.ok(button(view.container, "Testa mikrofonen"));
  await view.unmount();
});

test("earlier runs: Visa fler körningar puts the focus on the first run it added, so the keyboard goes on from there", async () => {
  const { createElement, useState } = await import("react");
  const { EarlierRuns } = await import("../components/flow/EarlierRuns");
  const run = (id: string) => ({ id, flow_id: "flow-1", status: "completed", created_at: new Date().toISOString() });
  function Page() {
    const [runs, setRuns] = useState([run("a")]);
    return createElement(EarlierRuns, {
      list: { runs, hasMore: runs.length < 3, loading: false, failed: null },
      onOpen: () => {},
      onMore: () => setRuns([run("a"), run("b"), run("c")]),
    });
  }
  const view = await mount(createElement(Page));
  await view.act(async () => button(view.container, "Visa fler körningar")!.click());
  const opens = [...view.container.querySelectorAll("[data-open-run]")];
  assert.equal(opens.length, 3);
  assert.equal(document.activeElement, opens[1], "the first of the added runs, not the top of the list");
  assert.equal(button(view.container, "Visa fler körningar"), null, "all shown: no more to show");
  await view.unmount();
});

test("upload: the whole drop zone opens the file chooser, the chooser knows the flow's extensions, and the zone is no extra Tab stop", async () => {
  const { createElement, createRef } = await import("react");
  const { UploadPanel } = await import("../components/flow/UploadPanel");
  const inputRef = createRef<HTMLInputElement>();
  const chosen: string[] = [];
  const step = { step_id: "step-doc", input_format: "document", accepted_mimetypes: ["text/markdown", "application/pdf"] };
  const view = await mount(
    createElement(UploadPanel, { step, file: null, audio: false, inputRef, onChoose: (file: File) => chosen.push(file.name) }),
  );
  const input = inputRef.current!;
  let opened = 0;
  input.addEventListener("click", () => (opened += 1));

  const zone = view.container.querySelector<HTMLElement>("[data-drop-zone]")!;
  await view.act(async () => zone.querySelector("span")!.click());
  assert.equal(opened, 1, "a click anywhere on the zone opens the chooser");
  assert.equal(input.accept, "text/markdown,.md,.markdown,application/pdf,.pdf");
  assert.equal(zone.tabIndex, -1, "the zone takes no focus: the primary button is the one keyboard stop");
  assert.equal(input.tabIndex, -1);

  Object.defineProperty(input, "files", { value: [new File(["# Plan"], "underlag.md")], configurable: true });
  await view.act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  assert.deepEqual(chosen, ["underlag.md"]);
  await view.unmount();
});

test("upload: a file dropped on the zone is chosen, the first of several; something dragged that is no file is left alone", async () => {
  const { createElement, createRef } = await import("react");
  const { UploadPanel } = await import("../components/flow/UploadPanel");
  const chosen: string[] = [];
  const view = await mount(
    createElement(UploadPanel, { step: null, file: null, audio: true, inputRef: createRef<HTMLInputElement>(), onChoose: (file: File) => chosen.push(file.name) }),
  );
  const zone = view.container.querySelector<HTMLElement>("[data-drop-zone]")!;
  const drag = (type: string, types: string[], files: File[] = []) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types, files } });
    zone.dispatchEvent(event);
    return event.defaultPrevented;
  };
  let over = true;
  await view.act(async () => {
    over = drag("dragover", ["text/plain"]);
  });
  assert.equal(over, false, "a dragged text is not taken: the browser's own handling stays");
  await view.act(async () => void drag("drop", ["text/plain"]));
  // Dropping with no file in it (the guard was only on the drag over) chooses nothing.
  assert.deepEqual(chosen, []);
  await view.act(async () => {
    over = drag("dragover", ["Files"]);
  });
  assert.equal(over, true, "a file is welcome");
  await view.act(async () => void drag("drop", ["Files"], [new File(["a"], "forst.mp3"), new File(["b"], "andra.mp3")]));
  assert.deepEqual(chosen, ["forst.mp3"], "the first file only");
  await view.unmount();
});

/** A page's router, colour mode and signed-in user, as the app gives them; `visited` is where the router went. */
async function signedIn(element: import("react").ReactElement, where?: { path?: string; entries?: string[] }) {
  const { createElement } = await import("react");
  const { AuthenticatedUserContext } = await import("../components/AuthGate");
  const { ColorModeProvider } = await import("@/kit/ColorModeProvider");
  const user = { id: "user-1", email: "anna@example.se", username: "Anna" };
  return withRouter(createElement(ColorModeProvider, null, createElement(AuthenticatedUserContext.Provider, { value: user }, element)), where);
}

const exits = (container: HTMLElement) => ({
  links: container.querySelectorAll('a[href="/flows"]').length,
  account: [...container.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label")?.startsWith("Öppna konto")).length,
});

const IBIC = {
  id: "flow-6",
  name: "Genomförandeplan IBIC",
  description: "Skapar en genomförandeplan ur en utredning.",
  published_version: 2,
} as import("./api").FlowPublished;
const IBIC_CONTRACT = {
  flow_id: "flow-6",
  published_flow_version: 2,
  form_fields: [
    { name: "deltagare", label: "Deltagare", type: "list" },
    { name: "talare", label: "Antal talare", type: "text" },
    { name: "arende", label: "Ärende", type: "text" },
  ],
  steps_requiring_input: [],
} as unknown as import("./api").RunContract;

test("a run's states keep the flow's page: the way back, the flow, and the details it was started with, read only", async () => {
  const { createElement } = await import("react");
  const { FlowRunPage } = await import("../components/flow/FlowRunPage");
  const view = await mount(
    (
      await signedIn(
        createElement(
          FlowRunPage,
          { published: IBIC, contract: IBIC_CONTRACT, input: { deltagare: ["Max", "Alexander"], talare: "4", okand: "x" }, version: 2 },
          createElement("h1", null, "Dokumentet skapas"),
        ),
      )
    ).tree,
  );
  // The shell's one main region: a div with the role, not a <main> element.
  const main = view.container.querySelector('[role="main"]')!;
  const bar = view.container.querySelector('[role="banner"]')!;
  assert.ok([...bar.querySelectorAll('a[href="/flows"]')].some((a) => a.textContent?.trim() === "Alla flöden"), "the way back is the bar's");
  assert.match(main.textContent ?? "", /Genomförandeplan IBIC/);
  assert.match(main.textContent ?? "", /Skapar en genomförandeplan ur en utredning\./);
  const rows = [...main.querySelectorAll("dt")].map((dt) => `${dt.textContent}: ${dt.nextElementSibling?.textContent}`);
  assert.deepEqual(rows, ["Deltagare: Max, Alexander", "Antal talare: 4"], "the filled details in the form's order, nothing Eneo added");
  assert.equal(main.querySelectorAll("input, textarea, select").length, 0, "no editable form");
  const headings = [...view.container.querySelectorAll("h1")].map((h) => h.textContent);
  assert.deepEqual(headings, ["Dokumentet skapas"], "the state's heading stays the page's one h1");
  await view.unmount();
});

test("setup in place of a run's view focuses its heading, also for a flow that takes one kind of file; a first load does not", async () => {
  const { createElement } = await import("react");
  const { FlowInput } = await import("../components/flow/FlowInput");
  const { useFlowSession } = await import("../components/flow/useFlowSession");
  // One way to give the input (a document to upload), so there is no "Hur vill du lägga till ljudet?" to focus.
  const contract = { ...IBIC_CONTRACT, steps_requiring_input: [{ step_id: "step-doc", input_format: "document" }] } as unknown as import("./api").RunContract;
  function Setup({ afterRun }: { afterRun: boolean }) {
    const input = useFlowSession({ flowId: "flow-6", flowName: IBIC.name, ownerId: "user-1", contract });
    return createElement(FlowInput, {
      published: IBIC,
      contract,
      input,
      ownerId: "user-1",
      notice: null,
      earlierRuns: { runs: [], hasMore: false, loading: false, failed: null },
      onOpenRun: () => undefined,
      onMoreRuns: () => undefined,
      unsent: { recordings: [], unreadable: false, retry: () => undefined },
      afterRun,
    });
  }
  for (const afterRun of [false, true]) {
    const view = await mount((await signedIn(createElement(Setup, { afterRun }))).tree);
    const focused = document.activeElement;
    const where = `${focused?.tagName} "${focused?.textContent?.slice(0, 40)}"`;
    if (afterRun) assert.ok(focused?.matches("h2[data-phase-heading]") && focused.textContent === "Ladda upp", `after a run: focus on ${where}`);
    else assert.ok(focused === document.body, `first load: focus on ${where}`);
    await view.unmount();
  }
});

test("a run's tab title names its state and its flow, so tabs and history entries of different flows differ", async () => {
  const { createElement } = await import("react");
  const { RunProgress } = await import("../components/flow/RunProgress");
  const { RunFailure } = await import("../components/flow/RunFailure");
  const running = await mount(createElement(RunProgress, { flowName: "Nämndmöte", steps: [], stage: "Startar körningen", onCancel: async () => undefined }));
  assert.equal(document.title, "Skapar dokument · Nämndmöte · Tal till text");
  await running.unmount();
  const failed = await mount(
    createElement(RunFailure, { flowId: "flow-1", flowName: "Nämndmöte", run: { id: "run-1", status: "failed" }, failure: null, steps: [], stepResults: [], files: [] }),
  );
  assert.equal(document.title, "Misslyckades · Nämndmöte · Tal till text");
  await failed.unmount();
});

test("the folded steps open on their trigger, say so in its label, and fold again", async () => {
  const { createElement } = await import("react");
  const { StepDetails } = await import("../components/flow/StepDetails");
  const steps = [
    { order: 1, label: "Transkribera mötet", state: "done" as const, transcribes: true, note: null },
    { order: 2, label: "Skapa rapport", state: "waiting" as const, transcribes: false, note: "Här granskar du resultatet." },
  ];
  const view = await mount(createElement(StepDetails, { steps, version: 3 }));
  const trigger = () => view.container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  assert.equal(trigger().getAttribute("aria-expanded"), "false", "closed to begin with");
  assert.equal(trigger().textContent, "Hur resultatet togs fram 2 steg");
  await view.act(async () => trigger().click());
  assert.equal(trigger().getAttribute("aria-expanded"), "true");
  assert.equal(trigger().textContent, "Dölj hur resultatet togs fram 2 steg");
  await view.act(async () => trigger().click());
  assert.equal(trigger().getAttribute("aria-expanded"), "false");
  assert.equal(trigger().textContent, "Hur resultatet togs fram 2 steg");
  await view.unmount();
});

/** A running view with its cancel question, and the question's dialog as the page has it. */
async function mountRunning(onCancel: () => Promise<void>, extra: Record<string, unknown> = {}) {
  const { createElement } = await import("react");
  const { RunProgress } = await import("../components/flow/RunProgress");
  const view = await mount(createElement(RunProgress, { flowName: "Nämndmöte", steps: [], stage: "Startar körningen", onCancel, ...extra }));
  const question = () => document.body.querySelector<HTMLDialogElement>('dialog[role="alertdialog"]')!;
  const ask = () => view.act(async () => button(view.container, "Avbryt körningen")!.click());
  return { view, question, ask };
}

test("the cancel question: Kör vidare leaves the run alone, Avbryt körningen cancels it once and closes the question", async () => {
  let cancelled = 0;
  const { view, question, ask } = await mountRunning(async () => void (cancelled += 1));
  assert.equal(question().hasAttribute("open"), false, "not asked until the button is pressed");
  await ask();
  assert.equal(question().hasAttribute("open"), true);
  assert.match(question().textContent ?? "", /Avbryta körningen\?.*Flödet slutar arbeta och inget dokument skapas\./);

  await view.act(async () => button(question(), "Kör vidare")!.click());
  assert.equal(question().hasAttribute("open"), false);
  assert.equal(cancelled, 0);

  await ask();
  await view.act(async () => button(question(), "Avbryt körningen")!.click());
  assert.equal(question().hasAttribute("open"), false, "answered, so closed");
  assert.equal(cancelled, 1);
  await view.unmount();
});

test("a cancel that is on its way keeps its button off until Eneo has answered, and a refusal shows once as an alert", async () => {
  let answer: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => (answer = resolve));
  const { view, question, ask } = await mountRunning(() => pending, { error: "Körningen kunde inte avbrytas just nu." });
  const trigger = () => button(view.container, "Avbryt körningen")!;
  assert.equal(view.container.querySelectorAll('[role="alert"]').length, 1);
  assert.match(view.container.querySelector('[role="alert"]')?.textContent ?? "", /Körningen kunde inte avbrytas just nu\./);
  assert.equal(trigger().disabled, false);

  await ask();
  await view.act(async () => button(question(), "Avbryt körningen")!.click());
  assert.equal(trigger().disabled, true, "pressed twice, cancelled once");
  assert.equal(trigger().getAttribute("aria-busy"), "true");
  await view.act(async () => answer());
  assert.equal(trigger().disabled, false, "free again once it is settled");
  await view.unmount();
});

test("a run that ends while its cancel question is open takes the question and the page's lock with it", async () => {
  const { view, question, ask } = await mountRunning(async () => undefined);
  await ask();
  assert.equal(question().hasAttribute("open"), true);
  assert.equal(document.body.style.position, "fixed", "the page is held still while it is asked");
  await view.unmount();
  assert.equal(document.body.querySelector("dialog[open]"), null, "no question left open");
  assert.equal(document.body.style.position, "", "the page scrolls again");
  assert.equal(document.body.style.overflow, "");
});

test("the cancel question is closed while the login has ended and asked again after the new one", async () => {
  const { loginState } = await import("./login-state");
  const anna = { id: "user-1", email: "anna@example.se", username: "Anna" };
  const end = loginState.begin(anna);
  const { view, question, ask } = await mountRunning(async () => undefined);
  try {
    await ask();
    assert.equal(question().hasAttribute("open"), true);
    await view.act(async () => loginState.ended());
    assert.equal(question().hasAttribute("open"), false, "a native dialog would stay above the covered page");
    await view.act(async () => loginState.observe({ authenticated: true, user: anna, session_ends_in: 8 * 3600 }));
    assert.equal(question().hasAttribute("open"), true, "back, as it was asked");
  } finally {
    end();
    await view.unmount();
  }
});

test("Försök igen on a failed run is busy and off while Eneo answers, so a second press cannot start it twice", async () => {
  const { createElement } = await import("react");
  const { RunFailure } = await import("../components/flow/RunFailure");
  let answer: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => (answer = resolve));
  let retries = 0;
  const view = await mount(
    createElement(RunFailure, {
      flowId: "flow-1",
      flowName: "Nämndmöte",
      run: { id: "run-1", status: "failed", error: { code: "flow_provider_unavailable", message: "x", retryable: true } },
      failure: null,
      steps: [],
      stepResults: [],
      files: [],
      onRetry: () => {
        retries += 1;
        return pending;
      },
    }),
  );
  const retry = () => button(view.container, "Försök igen")!;
  assert.equal(retry().disabled, false);
  await view.act(async () => retry().click());
  await view.act(async () => retry().click());
  assert.equal(retries, 1);
  assert.equal(retry().disabled, true);
  assert.equal(retry().getAttribute("aria-busy"), "true");
  await view.act(async () => answer());
  assert.equal(retry().disabled, false, "free again once Eneo has answered");
  await view.unmount();
});

test("a run of an earlier version of the flow shows no details labelled by today's form", async () => {
  const { createElement } = await import("react");
  const { FlowRunPage } = await import("../components/flow/FlowRunPage");
  for (const version of [1, null]) {
    const view = await mount(
      (await signedIn(createElement(FlowRunPage, { published: IBIC, contract: IBIC_CONTRACT, input: { deltagare: ["Max"], talare: "4" }, version }))).tree,
    );
    assert.equal(view.container.querySelectorAll("dt").length, 0, `version ${version}: the form may have changed since`);
    assert.ok(!(view.container.textContent ?? "").includes("Max"), "nor the values, unlabelled");
    await view.unmount();
  }
});

test("upload under way: the header offers no way off the page, which would abort the upload unasked; Avbryt is the way out", async () => {
  const { createElement } = await import("react");
  const { SubmittingView } = await import("../components/flow/SubmittingView");
  const { FlowRunPage } = await import("../components/flow/FlowRunPage");
  let cancelled = 0;
  const submission = { kind: "uploading", filename: "underlag.pdf", loaded: 0, total: 2048, percent: 0, wait: null } as const;
  const { tree, visited } = await signedIn(
    createElement(
      FlowRunPage,
      { published: IBIC, contract: IBIC_CONTRACT, input: { deltagare: ["Anna Berg"] }, version: 2, locked: true },
      createElement(SubmittingView, { submission, onCancelSubmission: () => (cancelled += 1) }),
    ),
  );
  const view = await mount(tree);
  assert.deepEqual(exits(view.container), { links: 0, account: 0 }, "no back link, no brand link, no sign-out while it uploads");

  await view.act(async () => button(view.container, "Avbryt")!.click());
  assert.equal(cancelled, 1);
  assert.deepEqual(visited, []);
  await view.unmount();
});

test("every state of the flow's page keeps the same bar: the way back and the account (signing out asks first while something would be lost)", async () => {
  const { createElement } = await import("react");
  const { FlowFrame } = await import("../components/flow/FlowFrame");
  const view = await mount((await signedIn(createElement(FlowFrame, { fill: true, children: null }))).tree);
  assert.deepEqual(exits(view.container), { links: 1, account: 1 });
  await view.unmount();
});

test("the way back: a link to the flow list named Alla flöden, a router link", async () => {
  const { createElement } = await import("react");
  const { BackToFlows } = await import("../components/flow/BackToFlows");
  const { router, tree } = await signedIn(createElement(BackToFlows));
  const view = await mount(tree);
  const links = [...view.container.querySelectorAll("a")];
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute("href"), "/flows");
  assert.equal(links[0].textContent?.trim(), "Alla flöden");
  await view.act(async () => void links[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
  assert.equal(router.state.location.pathname, "/flows", "a navigation of the router, not a page load");
  await view.unmount();
});

test("the phone top bar's back chevron is named like every other way back", async () => {
  const { createElement } = await import("react");
  const { FlowFrame } = await import("../components/flow/FlowFrame");
  const view = await mount((await signedIn(createElement(FlowFrame, { title: "Nämndmöte", children: null }))).tree);
  const chevron = view.container.querySelector('[role="banner"] a[aria-label="Alla flöden"]');
  assert.ok(chevron, "the arrow in the bar is named like every other way back");
  assert.equal(chevron.getAttribute("href"), "/flows");
  await view.unmount();
});

test("a sign-out that was answered but did not go through leaves no way off the page unasked: the next departure asks", async () => {
  const { createElement } = await import("react");
  const { useLeaveQuestion } = await import("../components/flow/useLeaveQuestion");
  function Page() {
    const leaving = useLeaveQuestion(true, "Det du har skrivit försvinner om du lämnar sidan.");
    // A sign-out whose request fails: it goes on, and no navigation follows.
    return createElement("div", null, createElement("button", { onClick: () => leaving.leaveFirst(async () => undefined) }, "Logga ut"), leaving.question);
  }
  const { tree, router } = await signedIn(createElement(Page), { path: "/flows/f1", entries: ["/flows/f1"] });
  const view = await mount(tree);
  const dialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"][open]');
  await view.act(async () => button(view.container, "Logga ut")!.click());
  assert.ok(dialog(), "Logga ut asks");
  await view.act(async () => {
    button(dialog()!, "Lämna sidan")!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.ok(!dialog(), "answered");
  await view.act(async () => void router.navigate("/flows"));
  assert.ok(dialog(), "a way off the page right after is asked about too");
  assert.equal(router.state.location.pathname, "/flows/f1", "and the page is still here");
  await view.unmount();
});

test("Back during an upload asks first and says what leaving stops; Stanna kvar stays, Lämna sidan goes on", async () => {
  const { createElement } = await import("react");
  const { useLeaveQuestion } = await import("../components/flow/useLeaveQuestion");
  const { leaveWarning } = await import("./recording-view");
  function Page() {
    // A file on its way: the page holds no audio.
    return useLeaveQuestion(true, leaveWarning(true, "setup", true)).question;
  }
  const { tree, router } = await signedIn(createElement(Page), { entries: ["/flows", "/"] });
  const view = await mount(tree);
  // A native dialog stays in the tree while it is closed: open is its open attribute.
  const dialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"][open]');
  await view.act(async () => void router.navigate(-1));
  assert.match(dialog()?.textContent ?? "", /Lämna sidan\?/);
  assert.match(dialog()?.textContent ?? "", /Sändningen avbryts/);
  // The design system's convention: a native alert dialog, and the answer that loses nothing has the focus.
  assert.equal(dialog()!.tagName, "DIALOG", "a native dialog: it needs no portal and stacks above the sign-in dialog");
  assert.ok(button(dialog()!, "Lämna sidan"), "leaving is the other answer");
  assert.ok(document.activeElement === button(dialog()!, "Stanna kvar"), "staying has the focus");
  assert.equal(router.state.location.pathname, "/", "the page is still here while it is asked");
  await view.act(async () => button(dialog()!, "Stanna kvar")!.click());
  assert.ok(!dialog(), "answered: closed");
  assert.equal(router.state.location.pathname, "/", "and stayed");

  await view.act(async () => void router.navigate(-1));
  assert.ok(dialog(), "asked again for the next Back");
  await view.act(async () => button(dialog()!, "Lämna sidan")!.click());
  assert.equal(router.state.location.pathname, "/flows", "Lämna sidan goes on back");
  await view.unmount();
});

test("repeated Back while the question is open leaves one question, and Stanna kvar stays", async () => {
  const { createElement } = await import("react");
  const { useLeaveQuestion } = await import("../components/flow/useLeaveQuestion");
  function Page() {
    return useLeaveQuestion(true, "Det som spelats in finns kvar bland osända inspelningar.").question;
  }
  const { tree, router } = await signedIn(createElement(Page), { entries: ["/start", "/flows", "/"] });
  const view = await mount(tree);
  const dialogs = () => document.body.querySelectorAll('[role="alertdialog"][open]').length;
  for (let press = 0; press < 3; press += 1) await view.act(async () => void router.navigate(-1));
  assert.equal(dialogs(), 1, "one question, nothing stacked");
  await view.act(async () => button(document.body.querySelector<HTMLElement>('[role="alertdialog"][open]')!, "Stanna kvar")!.click());
  assert.equal(dialogs(), 0);
  assert.equal(router.state.location.pathname, "/", "still on the page");
  await view.unmount();
});

test("an address the page writes that keeps the page is no departure, and a page that is not asking is left without a question", async () => {
  const { createElement, useState } = await import("react");
  const { useLeaveQuestion } = await import("../components/flow/useLeaveQuestion");
  let setActive: (active: boolean) => void = () => {};
  function Page() {
    const [active, set] = useState(true);
    setActive = set;
    return useLeaveQuestion(active, "Det som spelats in finns kvar bland osända inspelningar.").question;
  }
  const { tree, router } = await signedIn(createElement(Page), { path: "/flows/:id", entries: ["/flows", "/flows/f1"] });
  const view = await mount(tree);
  const dialogs = () => document.body.querySelectorAll('[role="alertdialog"][open]').length;
  await view.act(async () => void router.navigate({ search: "?run=r1" }, { replace: true }));
  assert.equal(dialogs(), 0, "the page writing its own address asks nothing");
  assert.equal(router.state.location.search, "?run=r1");
  await view.act(async () => void router.navigate("/flows"));
  assert.equal(dialogs(), 1, "another page asks");
  await view.act(async () => button(document.body.querySelector<HTMLElement>('[role="alertdialog"][open]')!, "Stanna kvar")!.click());
  await view.act(async () => setActive(false));
  await view.act(async () => void router.navigate("/flows"));
  assert.equal(dialogs(), 0, "nothing to lose, nothing asked");
  assert.equal(router.state.location.pathname, "/flows");
  await view.unmount();
});

test("signed out, Back still asks in a native dialog that is open, focused and answerable", async () => {
  const { createElement } = await import("react");
  const { useLeaveQuestion } = await import("../components/flow/useLeaveQuestion");
  const { SignedOutCover } = await import("../components/AuthGate");
  function Recording() {
    return useLeaveQuestion(true, "Det som spelats in finns kvar bland osända inspelningar.").question;
  }
  const { tree, router } = await signedIn(createElement(SignedOutCover, { signedOut: true, children: createElement(Recording) }), { entries: ["/flows", "/"] });
  const view = await mount(tree);
  await view.act(async () => void router.navigate(-1));
  const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"][open]');
  assert.ok(dialog, "asked");
  // Booleans only: a failed comparison of DOM nodes makes node print them, which takes minutes under jsdom.
  // The question sits in the covered page's tree, and the browser lifts a modal dialog out of an inert ancestor:
  // that, and its stacking above the sign-in dialog, are proved in tests/e2e/session-cover.spec.ts.
  assert.equal(dialog.tagName, "DIALOG", "a native dialog");
  assert.ok(dialog.hasAttribute("open"), "opened as a modal");
  assert.ok(dialog.contains(document.activeElement), "the focus is in the question");
  await view.act(async () => button(dialog, "Stanna kvar")!.click());
  assert.ok(!document.body.querySelector('[role="alertdialog"][open]'), "and it can be answered");
  await view.unmount();
});

test("while leaving would lose typed work, the top bar's links and Logga ut ask first", async (t) => {
  const { createElement } = await import("react");
  const { LeaveContext, useLeaveQuestion } = await import("../components/flow/useLeaveQuestion");
  const { FlowFrame } = await import("../components/flow/FlowFrame");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  let loggedOut = 0;
  const browserFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    loggedOut += 1;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = browserFetch;
  });
  function Review() {
    const leaving = useLeaveQuestion(true, "Det du har skrivit kunde inte sparas i webbläsaren och försvinner om du lämnar sidan.");
    return createElement(
      LeaveContext.Provider,
      { value: leaving },
      createElement(FlowFrame, { title: "Sammanfattning", titleIsHeading: false, children: null }),
      leaving.question,
    );
  }
  const { tree, visited, router } = await signedIn(createElement(Review), { path: "/flows/f1", entries: ["/flows/f1"] });
  const view = await mount(tree);
  const asked = () => document.body.querySelector<HTMLElement>('[role="alertdialog"][open]');

  await view.act(async () => view.container.querySelector<HTMLAnchorElement>('a[aria-label="Alla flöden"]')!.click());
  assert.ok(asked(), "Alla flöden asks");
  assert.deepEqual(visited, [], "and the page is still here");
  await view.act(async () => button(asked()!, "Stanna kvar")!.click());

  const account = [...view.container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label")?.startsWith("Öppna konto"))!;
  await view.act(async () => {
    account.click();
    await settle();
  });
  const logOut = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.includes("Logga ut"))!;
  await view.act(async () => {
    logOut.click();
    await settle();
  });
  assert.ok(asked(), "Logga ut asks");
  assert.equal(loggedOut, 0, "not signed out yet");
  await view.act(async () => {
    button(asked()!, "Lämna sidan")!.click();
    await settle();
  });
  assert.equal(loggedOut, 1, "signed out once the user chose to leave");
  assert.equal(router.state.location.pathname, "/", "and gone to the start");
  assert.ok(!asked(), "which the question did not ask about a second time");
  await view.unmount();
});

test("a review edit comes back on its revision; once the review changed it is neither applied nor lost, but waits as din version", async (t) => {
  t.after(() => window.sessionStorage.clear());
  const { createElement, useState } = await import("react");
  const { useReviewDraft } = await import("../components/useReviewDraft");
  type Edit = { text?: string };
  const isEdit = (value: unknown): value is Edit => typeof value === "object" && value !== null && !Array.isArray(value);
  let draft = null as unknown as ReturnType<typeof useReviewDraft<Edit>>;
  let setRevision: (revision: number) => void = () => {};
  function Review({ start }: { start: number }) {
    const [revision, set] = useState(start);
    setRevision = set;
    draft = useReviewDraft<Edit>("user-1", "review:run-1:cp-1", revision, isEdit);
    return null;
  }
  const first = await mount(createElement(Review, { start: 3 }));
  await first.act(async () => draft.keep({ text: "Min text" }));
  await first.unmount(); // a reload
  const again = await mount(createElement(Review, { start: 3 }));
  assert.deepEqual(draft.initial, { text: "Min text" }, "back on the revision it was made on");

  await again.act(async () => setRevision(4)); // the save was refused as out of date, and the latest came in
  assert.equal(draft.initial, null, "never applied to the latest by itself");
  assert.deepEqual(draft.yours, { text: "Min text" }, "but kept, as din version");
  await again.act(async () => draft.drop()); // nothing typed on the latest: nothing to throw away
  assert.deepEqual(draft.yours, { text: "Min text" }, "not lost by the editor becoming clean");
  await again.act(async () => draft.keep({ text: "Ny text på den senaste" }));
  await again.unmount();
  const later = await mount(createElement(Review, { start: 4 }));
  assert.deepEqual(draft.initial, { text: "Ny text på den senaste" });
  assert.deepEqual(draft.yours, { text: "Min text" }, "an edit of the latest does not replace din version");

  let taken: Edit | null = null;
  await later.act(async () => {
    taken = draft.takeYours();
    draft.keep(taken!); // the page puts it in the editor, as its current edit
  });
  assert.deepEqual(taken, { text: "Min text" });
  assert.equal(draft.yours, null, "taken");
  assert.deepEqual(draft.initial, { text: "Min text" });
  await later.act(async () => setRevision(5)); // refused again, before anything else was typed
  await later.act(async () => {
    draft.keep(draft.takeYours()!);
  });
  assert.equal(draft.yours, null, "taken straight from the refused save");
  assert.deepEqual(draft.initial, { text: "Min text" });
  await later.act(async () => setRevision(6));
  await later.act(async () => draft.dropYours());
  assert.equal(draft.yours, null, "Behåll den senaste lets it go");
  await later.unmount();
  assert.equal(window.sessionStorage.length, 0, "nothing left behind");
});

test("a review edit the browser will not keep is still the page's, through a refused save; its only kept copy is never removed first", async (t) => {
  t.after(() => window.sessionStorage.clear());
  const { createElement, useState } = await import("react");
  const { useReviewDraft } = await import("../components/useReviewDraft");
  type Edit = { text?: string };
  const isEdit = (value: unknown): value is Edit => typeof value === "object" && value !== null && !Array.isArray(value);
  let draft = null as unknown as ReturnType<typeof useReviewDraft<Edit>>;
  let setRevision: (revision: number) => void = () => {};
  function Review({ start }: { start: number }) {
    const [revision, set] = useState(start);
    setRevision = set;
    draft = useReviewDraft<Edit>("user-1", "review:run-1:cp-9", revision, isEdit);
    return null;
  }
  const storage = Object.getPrototypeOf(window.sessionStorage) as Storage;
  const setItem = storage.setItem;
  let refuse: (key: string) => boolean = () => true;
  storage.setItem = function (this: Storage, key: string, value: string) {
    if (refuse(key)) throw new DOMException("full", "QuotaExceededError");
    return setItem.call(this, key, value);
  };
  t.after(() => {
    storage.setItem = setItem;
  });

  // Nothing kept by the browser: the page still has the edit, also as din version after the review changed.
  const refused = await mount(createElement(Review, { start: 3 }));
  await refused.act(async () => void draft.keep({ text: "Min text" }));
  assert.deepEqual(draft.initial, { text: "Min text" });
  await refused.act(async () => setRevision(4));
  assert.deepEqual(draft.yours, { text: "Min text" }, "din version, from the page itself");
  await refused.unmount();
  window.sessionStorage.clear();

  // Only din version refused: its one kept copy (the older revision's edit) is not written over.
  refuse = (key) => key.endsWith(":din");
  const kept = await mount(createElement(Review, { start: 3 }));
  await kept.act(async () => void draft.keep({ text: "Min text" }));
  await kept.act(async () => setRevision(4));
  await kept.act(async () => void draft.keep({ text: "Ny text" }));
  await kept.unmount();
  refuse = () => false;
  const reloaded = await mount(createElement(Review, { start: 4 }));
  assert.deepEqual(draft.yours, { text: "Min text" }, "din version survives the reload");
  await reloaded.unmount();
});

test("the recorder hears a muted microphone after 15 s of zeros, never a quiet room, and stops saying so when sound returns", async (t) => {
  const { createElement } = await import("react");
  const { useSilence } = await import("../components/flow/recording-hooks");
  // What the microphone gives: the loudest sample of each read.
  let peak = 0;
  class FakeAudioContext {
    state = "running";
    resume = async () => undefined;
    close = async () => undefined;
    createMediaStreamSource = () => ({ connect: () => undefined, disconnect: () => undefined });
    createAnalyser = () => ({ fftSize: 0, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0).fill(peak, 0, 1) });
  }
  const page = window as unknown as { AudioContext?: unknown };
  const browserAudio = page.AudioContext;
  page.AudioContext = FakeAudioContext;
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  let silent = false;
  const microphone = {} as MediaStream;
  function Recorder() {
    silent = useSilence(microphone, true);
    return null;
  }
  const view = await mount(createElement(Recorder));
  // A read at a time: a mocked tick moves the clock to its end before the timers it runs.
  const listen = (ms: number) =>
    view.act(async () => {
      for (let passed = 0; passed < ms; passed += 66) t.mock.timers.tick(66);
    });
  try {
    await listen(14_800);
    assert.equal(silent, false);
    await listen(400);
    assert.equal(silent, true, "15 s of zeros: a muted or wrong microphone");
    peak = 0.3;
    await listen(100);
    assert.equal(silent, false, "sound returns");
    peak = 10 ** (-70 / 20); // a quiet room's tone
    for (let minute = 0; minute < 10; minute += 1) {
      await listen(60_000);
      assert.equal(silent, false, `a quiet room, minute ${minute + 1}`);
    }
  } finally {
    await view.unmount();
    page.AudioContext = browserAudio;
  }
});

test("a second tap on Starta lands on Stoppa or Pausa, and neither ends or pauses the recording it just started", async (t) => {
  const { createElement } = await import("react");
  const { RecordingBar } = await import("../components/flow/Recorder");
  const { RecordingCapture } = await import("./recording-session");
  const { openRecordingStore } = await import("./recording-store");
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const unused = async () => {
    throw new Error("not used");
  };
  const capture = new RecordingCapture(() => openRecordingStore({}), { getStream: unused, createRecorder: () => unused() as never });
  const calls: string[] = [];
  const view = await mount(
    createElement(RecordingBar, {
      capture,
      phase: "recording",
      stream: null,
      showStatus: false,
      warnings: [],
      notes: [],
      onPause: () => calls.push("pause"),
      onStop: () => calls.push("stop"),
    }),
  );
  try {
    t.mock.timers.tick(300); // a double tap's second tap
    await view.act(async () => {
      button(view.container, "Stoppa")!.click();
      button(view.container, "Pausa")!.click();
    });
    assert.deepEqual(calls, []);
    t.mock.timers.tick(500);
    await view.act(async () => button(view.container, "Pausa")!.click());
    assert.deepEqual(calls, ["pause"], "a moment later, the controls work");
  } finally {
    await view.unmount();
  }
});

test("with reduced motion, the level meter still shows the microphone's level, without moving between levels", async (t) => {
  const { createElement } = await import("react");
  const { LevelMeter } = await import("../components/flow/LevelMeter");
  let peak = 0.5;
  class FakeAudioContext {
    state = "running";
    resume = async () => undefined;
    close = async () => undefined;
    createMediaStreamSource = () => ({ connect: () => undefined, disconnect: () => undefined });
    createAnalyser = () => ({ fftSize: 0, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(peak) });
  }
  const page = window as unknown as { AudioContext?: unknown; matchMedia: typeof window.matchMedia };
  const browserAudio = page.AudioContext;
  const browserMedia = page.matchMedia;
  page.AudioContext = FakeAudioContext;
  page.matchMedia = ((query: string) => ({ ...browserMedia(query), matches: query.includes("reduce") })) as typeof window.matchMedia;
  t.mock.timers.enable({ apis: ["setInterval"] });
  const view = await mount(createElement(LevelMeter, { stream: {} as MediaStream, bars: 8, variant: "steps" }));
  const lit = () => view.container.querySelectorAll('[data-lit="true"]').length;
  try {
    await view.act(async () => t.mock.timers.tick(66));
    assert.ok(lit() > 0, "speech lights the bars");
    peak = 0;
    for (let i = 0; i < 60; i += 1) await view.act(async () => t.mock.timers.tick(66));
    assert.equal(lit(), 0, "and silence lets them go");
  } finally {
    await view.unmount();
    page.AudioContext = browserAudio;
    page.matchMedia = browserMedia;
  }
});

/** A stream the meter listens to, a microphone that hears `peak`, and the audio context of a browser that has one. */
function listening(t: import("node:test").TestContext, peak: { value: number } | null) {
  class FakeAudioContext {
    state = "running";
    resume = async () => undefined;
    close = async () => undefined;
    createMediaStreamSource = () => ({ connect: () => undefined, disconnect: () => undefined });
    createAnalyser = () => ({ fftSize: 0, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(peak?.value ?? 0) });
  }
  const page = window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown };
  const before = { audio: page.AudioContext, webkit: page.webkitAudioContext };
  page.AudioContext = peak ? FakeAudioContext : undefined;
  page.webkitAudioContext = undefined;
  t.mock.timers.enable({ apis: ["setInterval"] });
  return () => {
    page.AudioContext = before.audio;
    page.webkitAudioContext = before.webkit;
  };
}

test("the level meter goes quiet when the stream ends, whichever way it is drawn", async (t) => {
  const { createElement } = await import("react");
  const { LevelMeter } = await import("../components/flow/LevelMeter");
  const restore = listening(t, { value: 0.5 });
  const stream = {} as MediaStream;
  try {
    for (const variant of ["steps", "wave"] as const) {
      const view = await mount(createElement(LevelMeter, { stream, bars: 8, variant }));
      const bars = [...view.container.querySelectorAll<HTMLElement>("span")];
      await view.act(async () => t.mock.timers.tick(66));
      assert.ok(variant === "steps" ? bars.some((bar) => bar.dataset.lit === "true") : bars.some((bar) => bar.style.transform !== "" && bar.style.transform !== "scaleY(0.12)"), `${variant}: sound moves it`);
      // Stopped, paused or revoked: the stream goes away and the meter settles at once, not at the next reading.
      await view.act(async () => view.rerender(createElement(LevelMeter, { stream: null, bars: 8, variant })));
      assert.ok(bars.every((bar) => bar.dataset.lit !== "true"), `${variant}: nothing lit`);
      if (variant === "wave") assert.ok(bars.every((bar) => bar.style.transform === "scaleY(0.12)"), "wave: every bar at its rest height");
      await view.unmount();
    }
  } finally {
    restore();
  }
});

test("a browser without an audio context still gets a level meter, at rest", async (t) => {
  const { createElement } = await import("react");
  const { LevelMeter } = await import("../components/flow/LevelMeter");
  const restore = listening(t, null);
  try {
    for (const variant of ["steps", "wave"] as const) {
      const view = await mount(createElement(LevelMeter, { stream: {} as MediaStream, bars: 8, variant }));
      await view.act(async () => t.mock.timers.tick(500));
      const bars = [...view.container.querySelectorAll<HTMLElement>("span")];
      assert.equal(bars.length, 8, `${variant}: the bars are there`);
      assert.ok(bars.every((bar) => bar.dataset.lit !== "true" && (variant === "steps" || bar.style.transform === "")), `${variant}: at rest`);
      await view.unmount();
    }
  } finally {
    restore();
  }
});

test("a kept review edit comes back only in the shape the review reads: any other, and any din version of another shape, is dropped from the storage and counts as none", async (t) => {
  t.after(() => window.sessionStorage.clear());
  const { createElement } = await import("react");
  const { useReviewDraft } = await import("../components/useReviewDraft");
  type Edit = { text: string };
  const isEdit = (value: unknown): value is Edit =>
    typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as Edit).text === "string";
  let draft = null as unknown as ReturnType<typeof useReviewDraft<Edit>>;
  function Review() {
    draft = useReviewDraft<Edit>("user-1", "review:run-1:cp-2", 3, isEdit);
    return null;
  }
  const current = "tal-till-text:draft:user-1:review:run-1:cp-2";
  const yours = `${current}:din`;
  const opened = async (kept: Record<string, string>) => {
    window.sessionStorage.clear();
    for (const [key, raw] of Object.entries(kept)) window.sessionStorage.setItem(key, raw);
    const view = await mount(createElement(Review));
    const read = { initial: draft.initial, yours: draft.yours };
    await view.unmount();
    return read;
  };
  for (const [what, raw] of [
    ["null", "null"],
    ["an object without a revision", "{}"],
    ["a list", '[{"revision": 3}]'],
    ["a revision that is text", '{"revision": "3", "edit": {"text": "x"}}'],
    ["an edit that is a number", '{"revision": 3, "edit": 5}'],
    ["an edit of another shape", '{"revision": 3, "edit": {"text": 5}}'],
  ]) {
    assert.deepEqual(await opened({ [current]: raw }), { initial: null, yours: null }, `${what} is no edit`);
    assert.equal(window.sessionStorage.getItem(current), null, `${what} is removed`);
  }
  assert.deepEqual(await opened({ [current]: '{"revision": 3, "edit": {"text": "Min text"}}' }), { initial: { text: "Min text" }, yours: null });
  assert.notEqual(window.sessionStorage.getItem(current), null, "an edit of the right shape stays");

  for (const [what, raw] of [
    ["null", "null"],
    ["an object without a text", "{}"],
    ["a list", '[{"text": "x"}]'],
    ["a text that is a number", '{"text": 5}'],
  ]) {
    assert.deepEqual(await opened({ [yours]: raw }), { initial: null, yours: null }, `${what} is no din version`);
    assert.equal(window.sessionStorage.getItem(yours), null, `${what} is removed`);
  }
  assert.deepEqual(await opened({ [yours]: '{"text": "Min version"}' }), { initial: null, yours: { text: "Min version" } });
});
