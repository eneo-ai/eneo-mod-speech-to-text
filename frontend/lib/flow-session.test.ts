import assert from "node:assert/strict";
import test from "node:test";

import type { RunContract } from "./api";
import { openRecordingStore, type RecordingStore } from "./recording-store";
import type { CaptureDeps } from "./recording-session";
import {
  FlowSession,
  availableModes,
  lastUsedFlow,
  primaryActionLabel,
  speakerLabelsFor,
  storageLine,
  withLastUsedFirst,
  type KeyValueStorage,
} from "./flow-session";

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function until(condition: () => boolean, what = "condition") {
  for (let i = 0; i < 1_000; i += 1) {
    if (condition()) return;
    await settle();
  }
  assert.fail(`${what} never happened`);
}

class FakeTrack extends EventTarget {
  readonly kind = "audio";
  readyState: MediaStreamTrackState = "live";
  muted = false;
  stop() {
    this.readyState = "ended";
  }
}

class FakeStream {
  readonly track = new FakeTrack();
  getTracks() {
    return [this.track];
  }
  getAudioTracks() {
    return [this.track];
  }
}

class FakeRecorder extends EventTarget {
  state: "inactive" | "recording" | "paused" = "inactive";
  start() {
    this.state = "recording";
  }
  pause() {
    this.state = "paused";
  }
  resume() {
    this.state = "recording";
  }
  requestData() {}
  emit(text: string) {
    this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: new Blob([text]) }));
  }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    setImmediate(() => {
      this.emit(".");
      this.dispatchEvent(new Event("stop"));
    });
  }
}

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => void (data[key] = value),
  };
}

const audioContract = (overrides: Partial<RunContract> = {}): RunContract => ({
  flow_id: "flow-1",
  published_flow_version: 3,
  form_fields: [
    { name: "deltagare", label: "Deltagare", type: "list", required: false },
    { name: "motesnamn", label: "Mötets namn", type: "text", required: true, default: "Kommunstyrelsen" },
  ],
  steps_requiring_input: [
    {
      step_id: "step-audio",
      input_format: "audio",
      max_files: 10,
      max_file_size_bytes: 50 * 1024 * 1024,
      accepted_mimetypes: ["audio/webm", "audio/mpeg"],
    },
  ],
  transcription: {
    live: { available: true, reason: null },
    speaker_labels: { selectable: true, required: false, default: true },
  },
  ...overrides,
});

async function setup(
  options: { store?: RecordingStore; storage?: KeyValueStorage; getStream?: CaptureDeps["getStream"] } = {},
) {
  const store = options.store ?? (await openRecordingStore({}));
  const streams: FakeStream[] = [];
  const recorders: FakeRecorder[] = [];
  const session = new FlowSession({
    flowId: "flow-1",
    flowName: "Nämndmöte till rapport",
    ownerId: "user-1",
    openStore: () => store,
    captureDeps: {
      getStream:
        options.getStream ??
        (async () => {
          const stream = new FakeStream();
          streams.push(stream);
          return stream as unknown as MediaStream;
        }),
      createRecorder: () => {
        const recorder = new FakeRecorder();
        recorders.push(recorder);
        return recorder as unknown as MediaRecorder;
      },
    },
    pickMimeType: () => "audio/webm;codecs=opus",
    storage: options.storage ?? memoryStorage(),
    liveClient: true,
  });
  return { session, store, streams, recorders };
}

test("the flow offers Strömma only when its live text is available, Spela in only when the browser can record, and Ladda upp always", () => {
  const withLive = audioContract();
  assert.deepEqual(availableModes(withLive, { canRecord: true, liveClient: true }), ["stromma", "spela-in", "ladda-upp"]);
  const noLive = audioContract({
    transcription: {
      live: { available: false, reason: "model_not_realtime" },
      speaker_labels: { selectable: true, required: false, default: true },
    },
  });
  assert.deepEqual(availableModes(noLive, { canRecord: true, liveClient: true }), ["spela-in", "ladda-upp"]);
  assert.deepEqual(availableModes(withLive, { canRecord: true, liveClient: false }), ["spela-in", "ladda-upp"]);
  assert.deepEqual(availableModes(withLive, { canRecord: false, liveClient: true }), ["ladda-upp"]);
  const documentFlow = audioContract({
    steps_requiring_input: [{ step_id: "step-doc", input_format: "document" }],
    transcription: null,
  });
  assert.deepEqual(availableModes(documentFlow, { canRecord: true, liveClient: true }), ["ladda-upp"]);
  assert.deepEqual(
    availableModes(audioContract({ steps_requiring_input: [] }), { canRecord: true, liveClient: true }),
    [],
  );
});

test("choosing a card only selects the mode; the microphone is asked for on the explicit start", async () => {
  let asked = 0;
  const { session } = await setup({
    getStream: async () => {
      asked += 1;
      return new FakeStream() as unknown as MediaStream;
    },
  });
  session.setContract(audioContract());
  session.selectMode("spela-in");
  session.selectMode("stromma");
  session.selectMode("spela-in");
  await settle();
  assert.equal(asked, 0, "choosing never asks for the microphone");
  assert.equal(session.getSnapshot().phase, "setup");

  await session.start();
  assert.equal(asked, 1);
  assert.equal(session.getSnapshot().phase, "recording");
});

test("the last chosen mode is remembered per flow and used when it is still offered", async () => {
  const storage = memoryStorage();
  const first = await setup({ storage });
  first.session.setContract(audioContract());
  assert.equal(first.session.getSnapshot().mode, "stromma", "the first offered mode by default");
  first.session.selectMode("ladda-upp");

  const again = await setup({ storage });
  again.session.setContract(audioContract());
  assert.equal(again.session.getSnapshot().mode, "ladda-upp");

  storage.setItem("tal-till-text:mode:flow-1", "stromma");
  const liveGone = await setup({ storage });
  liveGone.session.setContract(
    audioContract({
      transcription: {
        live: { available: false, reason: "model_unavailable" },
        speaker_labels: { selectable: true, required: false, default: true },
      },
    }),
  );
  assert.equal(liveGone.session.getSnapshot().mode, "spela-in", "a remembered mode no longer offered falls back");
});

test("the mode is fixed while recording and paused", async () => {
  const { session } = await setup();
  session.setContract(audioContract());
  session.selectMode("spela-in");
  await session.start();
  session.selectMode("ladda-upp");
  assert.equal(session.getSnapshot().mode, "spela-in");
  session.togglePause();
  assert.equal(session.getSnapshot().phase, "paused");
  session.selectMode("stromma");
  assert.equal(session.getSnapshot().mode, "spela-in");
});

test("speaker labels: off by default in Strömma, the flow's default otherwise, and an explicit choice survives mode changes", async () => {
  const option = { selectable: true, required: false, default: true };
  assert.equal(speakerLabelsFor(option, "stromma", null), false);
  assert.equal(speakerLabelsFor(option, "spela-in", null), true);
  assert.equal(speakerLabelsFor(option, "ladda-upp", null), true);
  assert.equal(speakerLabelsFor(option, "stromma", true), true);
  assert.equal(speakerLabelsFor({ ...option, selectable: false }, "spela-in", true), null, "not offered: nothing is sent");
  assert.equal(speakerLabelsFor(null, "spela-in", null), null);

  const { session } = await setup();
  session.setContract(audioContract());
  assert.equal(session.getSnapshot().speakerLabels, false, "Strömma is selected first");
  session.selectMode("spela-in");
  assert.equal(session.getSnapshot().speakerLabels, true);
  session.setSpeakerLabels(false);
  session.selectMode("ladda-upp");
  assert.equal(session.getSnapshot().speakerLabels, false, "the explicit choice is kept");
  session.selectMode("stromma");
  session.setSpeakerLabels(true);
  session.selectMode("spela-in");
  assert.equal(session.getSnapshot().speakerLabels, true);
});

test("details start from the flow's defaults, and a refreshed contract keeps the compatible ones", async () => {
  const { session } = await setup();
  session.setContract(audioContract());
  assert.deepEqual(session.getSnapshot().details, { motesnamn: "Kommunstyrelsen" });
  session.setDetail("deltagare", ["Anna Berg", "Erik Lund"]);
  session.setDetail("motesnamn", "Byggnadsnämnden");

  session.setContract(
    audioContract({
      published_flow_version: 4,
      form_fields: [
        { name: "deltagare", label: "Deltagare", type: "list" },
        { name: "motesnamn", label: "Mötets namn", type: "select", options: ["KS", "BN"] },
        { name: "datum", label: "Datum", type: "date", default: "2026-09-23" },
      ],
    }),
  );
  assert.deepEqual(session.getSnapshot().details, {
    deltagare: ["Anna Berg", "Erik Lund"],
    datum: "2026-09-23",
  });
});

test("the storage line says the recording is kept on the device only when the device store keeps it", () => {
  assert.equal(storageLine(true), "Inspelningen sparas på enheten medan du spelar in.");
  assert.equal(storageLine(false), "Låt sidan vara öppen under inspelningen.");
  assert.equal(storageLine(null), "Låt sidan vara öppen under inspelningen.", "unknown is never claimed");
});

test("each mode has its own primary action", () => {
  assert.equal(primaryActionLabel("stromma", false), "Starta strömning");
  assert.equal(primaryActionLabel("spela-in", false), "Starta inspelning");
  assert.equal(primaryActionLabel("ladda-upp", false), "Välj ljudfil");
  assert.equal(primaryActionLabel("ladda-upp", true), "Skapa dokument");
});

test("a denied or missing microphone says what happened and what to do next, and nothing is recorded", async () => {
  const denied = await setup({
    getStream: async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    },
  });
  denied.session.setContract(audioContract());
  denied.session.selectMode("spela-in");
  await denied.session.start();
  assert.equal(denied.session.getSnapshot().phase, "setup");
  assert.deepEqual(denied.session.getSnapshot().problem, {
    title: "Appen fick inte använda mikrofonen.",
    detail: "Tillåt mikrofonen i webbläsarens inställningar och försök igen.",
    retry: true,
  });
  assert.deepEqual(await denied.store.listUnsent("user-1"), []);

  const missing = await setup({
    getStream: async () => {
      throw new DOMException("Requested device not found", "NotFoundError");
    },
  });
  missing.session.setContract(audioContract());
  await missing.session.start();
  assert.deepEqual(missing.session.getSnapshot().problem, {
    title: "Ingen mikrofon hittades.",
    detail: "Anslut en mikrofon eller välj Ladda upp.",
  });

  // Choosing another mode clears the problem; so does a start that works.
  missing.session.selectMode("ladda-upp");
  assert.equal(missing.session.getSnapshot().problem, null);
});

test("stop leads to the ready state with the recording, never back to setup", async () => {
  const { session, recorders } = await setup();
  session.setContract(audioContract());
  session.selectMode("spela-in");
  await session.start();
  assert.equal(session.getSnapshot().phase, "recording");
  recorders[0].emit("audio");
  await session.stop();
  await until(() => session.getSnapshot().phase === "ready", "the ready state");
  const { recording } = session.getSnapshot();
  assert.equal(recording?.state, "stopped");
  assert.equal(recording?.flowId, "flow-1");
});

test("required details are checked when the document is made, not when recording starts", async () => {
  const sent: unknown[] = [];
  const { session, recorders } = await setup();
  session.setHandlers({ submit: async (request) => void sent.push(request) });
  session.setContract(audioContract());
  session.selectMode("spela-in");
  session.setDetail("motesnamn", "  ");
  await session.start();
  assert.equal(session.getSnapshot().phase, "recording", "an empty required field never blocks recording");
  recorders[0].emit("audio");
  await session.stop();
  await until(() => session.getSnapshot().phase === "ready");

  assert.equal(await session.createDocument(), false);
  assert.deepEqual(session.getSnapshot().invalid, ["motesnamn"]);
  assert.equal(sent.length, 0);

  session.setDetail("motesnamn", "Kommunstyrelsen");
  assert.deepEqual(session.getSnapshot().invalid, [], "filling the field clears its error");
});

test("Skapa dokument sends the recording with the details and the speaker choice, then starts over with the details kept", async () => {
  const sent: Array<Parameters<Parameters<FlowSession["setHandlers"]>[0]["submit"]>[0]> = [];
  const { session, recorders } = await setup();
  session.setHandlers({ submit: async (request) => void sent.push(request) });
  session.setContract(audioContract());
  session.selectMode("spela-in");
  session.setDetail("deltagare", ["Anna Berg", "Erik Lund"]);
  await session.start();
  recorders[0].emit("audio");
  await session.stop();
  await until(() => session.getSnapshot().phase === "ready");

  assert.equal(await session.createDocument(), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].input?.kind, "recording");
  assert.deepEqual(sent[0].payload, { deltagare: ["Anna Berg", "Erik Lund"], motesnamn: "Kommunstyrelsen" });
  assert.equal(sent[0].speakerLabels, true);
  const after = session.getSnapshot();
  assert.equal(after.phase, "setup");
  assert.equal(after.recording, null);
  assert.deepEqual(after.details.deltagare, ["Anna Berg", "Erik Lund"], "the participants stay for the next recording");
});

test("a chosen file becomes the document's input in Ladda upp; an unsent recording from the list goes the same way", async () => {
  const sent: Array<Parameters<Parameters<FlowSession["setHandlers"]>[0]["submit"]>[0]> = [];
  const { session, store } = await setup();
  session.setHandlers({ submit: async (request) => void sent.push(request) });
  session.setContract(audioContract());
  session.selectMode("ladda-upp");
  session.chooseFile(new File(["audio"], "mote.mp3", { type: "audio/mpeg" }));
  assert.equal(session.getSnapshot().file?.filename, "mote.mp3");
  assert.equal(await session.createDocument(), true);
  assert.equal(sent[0].input?.kind, "file");
  assert.equal(session.getSnapshot().file, null);

  const unsent = await store.create({
    ownerId: "user-1",
    flowId: "flow-1",
    flowName: "Nämndmöte till rapport",
    stepId: "step-audio",
    inputMode: "record",
    mimeType: "audio/webm",
  });
  session.adopt(unsent);
  assert.equal(session.getSnapshot().phase, "ready");
  assert.equal(session.getSnapshot().recording?.id, unsent.id);
  assert.equal(await session.createDocument(), true);
  assert.equal(sent[1].input?.kind, "recording");
});

test("a send that fails keeps the recording and the details, and says why", async () => {
  const { session, recorders, store } = await setup();
  session.setHandlers({
    submit: async () => {
      throw new Error("Anslutningen avbröts. Kontrollera nätverket och försök igen.");
    },
  });
  session.setContract(audioContract());
  session.selectMode("spela-in");
  session.setDetail("deltagare", ["Anna Berg"]);
  await session.start();
  recorders[0].emit("audio");
  await session.stop();
  await until(() => session.getSnapshot().phase === "ready");
  const recording = session.getSnapshot().recording!;

  assert.equal(await session.createDocument(), false);
  const after = session.getSnapshot();
  assert.equal(after.phase, "ready");
  assert.equal(after.recording?.id, recording.id);
  assert.deepEqual(after.details.deltagare, ["Anna Berg"]);
  assert.deepEqual(after.problem, { title: "Anslutningen avbröts. Kontrollera nätverket och försök igen." });
  assert.ok(await store.get(recording.id), "the audio is still on the device");
});

test("the flow list offers the flow this user last recorded or uploaded with first", async () => {
  const storage = memoryStorage();
  const { session } = await setup({ storage });
  session.setContract(audioContract());
  assert.equal(lastUsedFlow(storage, "user-1"), null, "opening a flow is not using it");
  session.selectMode("spela-in");
  await session.start();
  assert.equal(lastUsedFlow(storage, "user-1"), "flow-1");
  assert.equal(lastUsedFlow(storage, "user-2"), null);

  const flows = [{ id: "flow-0" }, { id: "flow-1" }, { id: "flow-2" }];
  assert.deepEqual(withLastUsedFirst(flows, "flow-1").map((flow) => flow.id), ["flow-1", "flow-0", "flow-2"]);
  assert.deepEqual(withLastUsedFirst(flows, "gone").map((flow) => flow.id), ["flow-0", "flow-1", "flow-2"]);
  assert.deepEqual(withLastUsedFirst(flows, null), flows);
});

test("a recording a reload cut off continues from the unsent list as a new part of the same recording", async () => {
  const { session, store, recorders } = await setup();
  session.setContract(audioContract());
  const earlier = await store.create({
    ownerId: "user-1",
    flowId: "flow-1",
    flowName: "Nämndmöte till rapport",
    stepId: "step-audio",
    inputMode: "record",
    mimeType: "audio/webm;codecs=opus",
  });
  await store.startPart(earlier.id);
  await store.append(earlier.id, 0, new Blob(["before the reload"]), 60_000);
  store.release(earlier.id); // the tab that recorded it is gone

  await session.continueCutOff((await store.get(earlier.id))!);
  const snapshot = session.getSnapshot();
  assert.equal(snapshot.phase, "recording");
  assert.equal(snapshot.mode, "spela-in");
  assert.equal(snapshot.recording?.id, earlier.id);
  assert.equal(recorders.length, 1, "one new part");

  recorders[0].emit("after");
  await session.stop();
  await until(() => session.getSnapshot().phase === "ready");
  assert.equal(session.getSnapshot().recording?.id, earlier.id);
  assert.equal(session.getSnapshot().recording?.parts.length, 2);
});
