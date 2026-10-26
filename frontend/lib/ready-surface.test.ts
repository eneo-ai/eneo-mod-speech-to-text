import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement, useSyncExternalStore } from "react";

import { loginState } from "./login-state";
import type { RunContract } from "./api";
import type { StoredRecording } from "./recording-store";
import { cleanup, installDom, mount } from "./test-dom";
import { unzippedText } from "./test-zip";

// The ready state where it is acted on: focus, presses and the delete question, which static markup cannot show.
installDom();
afterEach(cleanup);

const recording: StoredRecording = {
  id: "rec-1",
  ownerId: "user-1",
  flowId: "flow-1",
  flowName: "Nämndmöte till rapport",
  stepId: "step-audio",
  inputMode: "record",
  mimeType: "audio/webm;codecs=opus",
  startedAt: new Date(2026, 8, 23, 16, 13).getTime(),
  durationMs: 32 * 60_000,
  state: "stopped",
  parts: [{ index: 0, startedAt: 0, durationMs: 32 * 60_000, bytes: 87_859, chunks: 3, fileId: null }],
  runId: null,
};

const named = (within: ParentNode, name: string) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find((button) => (button.getAttribute("aria-label") ?? button.textContent?.trim()) === name) ?? null;

async function ready(props: Record<string, unknown> = {}) {
  const { ReadyPanel } = await import("../components/flow/ReadyPanel");
  const calls = { create: 0, discard: 0 };
  const view = await mount(
    createElement(ReadyPanel, {
      recording,
      persistent: true,
      problem: null,
      onCreate: () => void (calls.create += 1),
      onDiscard: () => void (calls.discard += 1),
      ...props,
    }),
  );
  return { ...view, calls };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const question = () => document.querySelector<HTMLDialogElement>('[role="alertdialog"]');

test("while Strömma's final text is on its way, Skapa dokument keeps its name and its focus, and a line says why it waits", async () => {
  const { ReadyPanel } = await import("../components/flow/ReadyPanel");
  const calls = { create: 0 };
  const panel = (finishing: boolean) =>
    createElement(ReadyPanel, { recording, persistent: true, problem: null, finishing, onCreate: () => void (calls.create += 1), onDiscard() {} });
  const view = await mount(panel(false));
  const create = named(view.container, "Skapa dokument")!;
  // The region that says it is there before it has anything to say, so that what it later holds is announced.
  const why = () => [...view.container.querySelectorAll("p")].find((p) => p.getAttribute("role") === "status");
  const region = why();
  assert.ok(region, "a status region is there from the start");
  assert.equal(region.textContent, "", "and says nothing while the text is not on its way");
  await view.act(async () => create.focus());

  await view.act(async () => view.rerender(panel(true)));
  assert.equal(why(), region, "the same region, so the change in it is announced");
  assert.equal(region.textContent, "Slutför texten…", "it says why the button waits");
  assert.equal(named(view.container, "Skapa dokument"), create, "the same button, under the same name");
  assert.equal(create.disabled, false, "not disabled: focus stays on it");
  assert.equal(create.getAttribute("aria-busy"), "true", "and says that it is busy");
  await view.act(async () => create.click());
  assert.equal(document.activeElement, create, "a press leaves the focus where it was");

  const queuedPanel = createElement(ReadyPanel, { recording, persistent: true, problem: null, finishing: true, finishQueued: true, onCreate() {}, onDiscard() {} });
  await view.act(async () => view.rerender(queuedPanel));
  assert.equal(region.textContent, "Slutför texten… Det skapas så snart den är klar.", "a press meanwhile is kept, and the line says so");

  await view.act(async () => view.rerender(panel(false)));
  assert.equal(region.textContent, "", "the line goes when the text is in");
  assert.equal(create.hasAttribute("aria-busy"), false);
  assert.equal(document.activeElement, create, "with the focus still on the button");
});

test("a press on Skapa dokument creates, once the text is in", async () => {
  const view = await ready();
  await view.act(async () => named(view.container, "Skapa dokument")!.click());
  assert.equal(view.calls.create, 1);
});

test("one line by the actions says where the recording is until then, where Skapa dokument sends it, and that it ends it", async () => {
  const words = async (props: Record<string, unknown>) => {
    const view = await ready(props);
    const text = view.container.textContent ?? "";
    await view.unmount();
    return text;
  };
  assert.match(
    await words({ onContinue: () => {} }),
    /Skapa dokument skickar inspelningen till Eneo\. Efteråt kan du inte fortsätta spela in\. Den finns kvar på enheten tills dokumentet är skapat\./,
  );
  // Nothing to go on with: the send is said, the ending is not.
  const alone = await words({});
  assert.match(alone, /Skapa dokument skickar inspelningen till Eneo\. Den finns kvar på enheten tills dokumentet är skapat\./);
  assert.doesNotMatch(alone, /fortsätta spela in/);
  assert.match(await words({ makesText: true }), /Skapa text skickar inspelningen till Eneo\. Den finns kvar på enheten tills texten är skapad\./);
  assert.match(await words({ persistent: false }), /Skapa dokument skickar inspelningen till Eneo\. Den finns bara i den här fliken, så stäng inte fliken innan dokumentet är skapat\./);
  // No send to speak of: only where the recording is.
  const kept = await words({ onCreate: undefined });
  assert.match(kept, /Inspelningen finns kvar på enheten tills dokumentet är skapat\./);
  assert.doesNotMatch(kept, /Eneo/);
});

test("with nothing to play, the player is left out and the next steps are still there", async () => {
  // The test document's store holds no parts of the recording: as when the device has lost them.
  const view = await ready();
  assert.equal(view.container.querySelector('[role="group"][aria-label^="Uppspelning"]'), null, "no player for a recording it cannot read");
  assert.doesNotMatch(view.container.textContent ?? "", /kunde inte läsas/, "a device with no parts is not an unreadable one");
  for (const name of ["Skapa dokument", "Spara ljudfil", "Ta bort"]) assert.ok(named(view.container, name), name);
});

test("a recording that cannot be saved as a file says so, and Spara ljudfil is still there to try again", async () => {
  // The device has the parts, and the browser cannot turn them into a download.
  const { recordingStore } = await import("./recording-store");
  const store = await recordingStore();
  const readParts = store.readParts;
  const createObjectURL = URL.createObjectURL;
  store.readParts = async () => [{ index: 0, filename: "inspelning.webm", blob: new Blob(["x"]), whole: true }];
  try {
    const view = await ready();
    await view.act(async () => undefined);
    URL.createObjectURL = () => {
      throw new Error("no object URLs");
    };
    await view.act(async () => named(view.container, "Spara ljudfil")!.click());
    await view.act(async () => undefined);
    assert.match(view.container.textContent ?? "", /Inspelningen kunde inte sparas som fil\./);
    assert.ok(named(view.container, "Spara ljudfil"), "and the button is still there");
  } finally {
    store.readParts = readParts;
    URL.createObjectURL = createObjectURL;
  }
});

test("a recording of two files says so on Spara ljudfil and saves both in one press, as one zip: a press while it saves adds none, and a failed save is tried again whole", async () => {
  const { recordingStore } = await import("./recording-store");
  const store = await recordingStore();
  const { readParts } = store;
  const { createObjectURL } = URL;
  const { click } = HTMLAnchorElement.prototype;
  const files = [
    { index: 0, filename: "inspelning-del-1.webm", blob: new Blob(["a"]), whole: true },
    { index: 1, filename: "inspelning-del-2.webm", blob: new Blob(["b"]), whole: true },
  ];
  let reading = Promise.resolve();
  let failing = false;
  store.readParts = async () => {
    await reading;
    if (failing) throw new Error("the database is not readable");
    return files;
  };
  const blobs = new Map<string, Blob>();
  const downloads: Array<{ name: string; blob: Blob }> = [];
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:${blobs.size}`;
    blobs.set(url, blob);
    return url;
  };
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, blob: blobs.get(this.href)! });
  };
  try {
    const part = recording.parts[0];
    const view = await ready({ recording: { ...recording, parts: [part, { ...part, index: 1 }] } });
    await view.act(async () => undefined);
    const save = named(view.container, "Spara 2 ljudfiler (zip)")!;
    assert.ok(save, "how many files, and that they come together as a zip, before the press");

    let read = () => {};
    reading = new Promise((resolve) => (read = resolve));
    await view.act(async () => {
      save.click();
      save.click(); // a second press while the files are read
    });
    assert.equal(save.getAttribute("aria-busy"), "true", "it says it is saving");
    assert.equal(save.disabled, false, "and keeps the focus a disabled button would lose");
    await view.act(async () => read());
    assert.deepEqual(downloads.map((download) => download.name), ["inspelning.zip"], "one download for the two presses");
    assert.deepEqual(await unzippedText(downloads[0].blob), [
      ["inspelning-del-1.webm", "a"],
      ["inspelning-del-2.webm", "b"],
    ]);
    assert.equal(save.textContent?.trim(), "Spara 2 ljudfiler (zip)", "the same press saves them all again");
    assert.equal(save.hasAttribute("aria-busy"), false);

    failing = true;
    await view.act(async () => save.click());
    assert.match(view.container.textContent ?? "", /Inspelningen kunde inte sparas som fil\./);
    failing = false;
    await view.act(async () => save.click());
    assert.doesNotMatch(view.container.textContent ?? "", /kunde inte sparas/);
    assert.equal(downloads.length, 2, "the save tried again saves both again");
  } finally {
    store.readParts = readParts;
    URL.createObjectURL = createObjectURL;
    HTMLAnchorElement.prototype.click = click;
  }
});

test("the delete question: Avbryt and Escape keep the recording; Ta bort discards once, closing first", async () => {
  const view = await ready();
  const trigger = named(view.container, "Ta bort")!;
  assert.equal(question()?.hasAttribute("open") ?? false, false, "nothing is asked until Ta bort is pressed");

  await view.act(async () => trigger.click());
  assert.ok(question()?.hasAttribute("open"), "the question opens");
  assert.equal(question()?.getAttribute("aria-label") ?? question()?.textContent?.includes("Ta bort inspelningen från enheten?"), true);
  assert.ok(question()?.textContent?.includes("Det går inte att ångra."), "in the words the unsent recordings ask it with");
  await view.act(async () => named(question()!, "Avbryt")!.click());
  assert.equal(question()?.hasAttribute("open"), false, "Avbryt closes it");
  assert.equal(document.activeElement, trigger, "and gives the focus back to Ta bort");
  assert.equal(view.calls.discard, 0, "the recording is kept");

  await view.act(async () => trigger.click());
  await view.act(async () => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(question()?.hasAttribute("open"), false, "Escape closes it");
  assert.equal(view.calls.discard, 0, "and keeps the recording");

  await view.act(async () => trigger.click());
  await view.act(async () => named(question()!, "Ta bort")!.click());
  assert.equal(view.calls.discard, 1, "Ta bort discards once");
  assert.equal(question()?.hasAttribute("open"), false, "and the question is closed");
});

test("the delete question is covered while the login has ended, and is back, as it was, with the new login", async () => {
  const anna = { id: "user-1", email: "anna@example.se", username: "Anna Berg" };
  const release = loginState.begin(anna);
  try {
    const view = await ready();
    const trigger = named(view.container, "Ta bort")!;
    await view.act(async () => trigger.click());
    assert.ok(question()?.hasAttribute("open"), "asked");
    await view.act(async () => loginState.ended());
    assert.equal(question()?.hasAttribute("open"), false, "the login ends: nothing of the question stays open over the sign-in dialog");
    await view.act(async () => loginState.observe({ authenticated: true, user: anna }));
    assert.ok(question()?.hasAttribute("open"), "the same person signs in again: the question is back");
    // Asked again with nothing of the page focused, it still gives the focus back to Ta bort when it is answered.
    (document.activeElement as HTMLElement | null)?.blur();
    await view.act(async () => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(question()?.hasAttribute("open"), false);
    assert.equal(document.activeElement, trigger, "back on the button that asked");
    assert.equal(view.calls.discard, 0);
  } finally {
    release();
  }
});

test("a recording the device cannot read says why there is no player, and the next steps are still there", async () => {
  const { recordingStore } = await import("./recording-store");
  const store = await recordingStore();
  const readParts = store.readParts;
  store.readParts = async () => {
    throw new Error("the database is not readable");
  };
  try {
    const view = await ready();
    await view.act(async () => undefined);
    assert.match(view.container.textContent ?? "", /Inspelningen kunde inte läsas på den här enheten, så den kan inte spelas upp\./);
    assert.equal(view.container.querySelector('[role="group"][aria-label^="Uppspelning"]'), null);
    for (const name of ["Skapa dokument", "Spara ljudfil", "Ta bort"]) assert.ok(named(view.container, name), name);
  } finally {
    store.readParts = readParts;
  }
});

test("an unconfirmed recorder's audio can be saved but cannot be sent until confirmation arrives", async () => {
  const pending = { ...recording, parts: recording.parts.map((part) => ({ ...part, endConfirmed: false })) };
  const view = await ready({ recording: pending });
  assert.equal(named(view.container, "Skapa dokument"), null);
  assert.ok(named(view.container, "Spara ljudfil"));
  assert.match(view.container.textContent!, /bekräftat inspelningens stopp/);
  const { ReadyPanel } = await import("../components/flow/ReadyPanel");
  await view.act(async () => view.rerender(createElement(ReadyPanel, { recording, persistent: true, problem: null, onCreate() {}, onDiscard() {} })));
  assert.ok(named(view.container, "Skapa dokument"));
  assert.doesNotMatch(view.container.textContent!, /bekräftat inspelningens stopp/);
});

/** A browser's recorder as the capture uses it: its last audio and its stop event come after the current task. */
class Recorder {
  state: RecordingState = "inactive";
  private listeners = new Map<string, Set<(event: unknown) => void>>();
  addEventListener(type: string, listener: (event: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  start() {
    this.state = "recording";
  }
  requestData() {}
  hand(data: Blob) {
    this.listeners.get("dataavailable")?.forEach((listener) => listener({ data }));
  }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    setImmediate(() => {
      this.hand(new Blob(["."]));
      this.listeners.get("stop")?.forEach((listener) => listener({}));
    });
  }
}

test("a stop the device's storage answers late shows no empty recording meanwhile, and the whole recording with Spara ljudfil once it answers", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { IDBFactory, IDBKeyRange } = await import("fake-indexeddb");
  const { openRecordingStore } = await import("./recording-store");
  const { FlowSession } = await import("./flow-session");
  const { ReadyPanel } = await import("../components/flow/ReadyPanel");
  const store = await openRecordingStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange });
  const recorders: Recorder[] = [];
  const track = { muted: false, readyState: "live", stop() {}, addEventListener() {}, removeEventListener() {} };
  const session = new FlowSession({
    flowId: "flow-1",
    flowName: "Nämndmöte till rapport",
    ownerId: "user-1",
    openStore: () => store,
    captureDeps: {
      getStream: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) as unknown as MediaStream,
      createRecorder: () => {
        recorders.push(new Recorder());
        return recorders.at(-1) as unknown as MediaRecorder;
      },
    },
    pickMimeType: () => "audio/webm;codecs=opus",
  });
  session.setContract({
    flow_id: "flow-1",
    published_flow_version: 1,
    form_fields: [],
    steps_requiring_input: [{ step_id: "step-audio", input_format: "audio", accepted_mimetypes: ["audio/webm"] }],
    transcription: { live: { available: false, reason: null }, speaker_labels: { selectable: true, required: false, default: false } },
  } as unknown as RunContract);
  session.selectMode("spela-in");
  await session.start();
  recorders[0].hand(new Blob(["a"]));
  // The device stops answering at the next audio (WebKit's IndexedDB has hung instead of failing): its write, and every
  // read and write after it, waits.
  let land: (() => void) | undefined;
  const late = new Blob(["b"]);
  recorders[0].hand(
    Object.assign(new Blob(["b"]), {
      arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => (land = () => void late.arrayBuffer().then(resolve))),
    }),
  );
  const stopping = session.stop();
  for (let i = 0; i < 1_000 && !land; i += 1) await settle();
  assert.ok(land, "the write that waits");
  for (let i = 0; i < 5; i += 1) await settle();
  t.mock.timers.tick(10_000);
  await stopping;
  // The ready state as FlowInput shows it.
  function Ready() {
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
    if (snapshot.phase !== "ready" || !snapshot.recording) return null;
    return createElement(ReadyPanel, {
      recording: snapshot.recording,
      awaitingDevice: snapshot.awaitingDevice,
      persistent: session.capture.getSnapshot().persistent,
      problem: snapshot.problem,
      onCreate() {},
      onContinue() {},
      onDiscard() {},
    });
  }
  const view = await mount(createElement(Ready));
  try {
    const said = () => view.container.textContent ?? "";
    assert.match(said(), /Inspelningen är klar/, "Stoppa ends without the device's word");
    assert.match(said(), /det gick inte att bekräfta att den sparades på enheten/, "and says what it has not confirmed");
    assert.equal(session.capture.getSnapshot().persistent, false, "leaving still asks");
    assert.doesNotMatch(said(), /Inget ljud sparades/, "audio the device has not read back is not said to be missing");
    assert.doesNotMatch(said(), / · 0/, "nor a length it does not know");
    assert.equal(named(view.container, "Fortsätt spela in"), null, "and nothing is offered on a recording not yet read back");

    // The device answers: the recording as it holds it, and the ways on with it.
    await view.act(async () => land!());
    for (let i = 0; i < 100 && !named(view.container, "Spara ljudfil"); i += 1) await view.act(settle);
    assert.ok(named(view.container, "Spara ljudfil"), "Spara ljudfil is back");
    assert.ok(named(view.container, "Skapa dokument"), "and Skapa dokument");
    assert.doesNotMatch(said(), /Inget ljud sparades/);
    assert.equal(session.getSnapshot().recording?.parts[0]?.bytes, 3, "the whole recording: every chunk the recorder handed over");
  } finally {
    await view.unmount();
    session.dispose();
  }
});
