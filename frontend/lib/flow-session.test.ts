import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, type RunContract } from "./api";
import { openRecordingStore, type RecordingStore } from "./recording-store";
import type { LiveSnapshot } from "./live-transcriber";
import type { CaptureDeps } from "./recording-session";
import {
  FlowSession,
  availableModes,
  acceptedFormats,
  lastUsedFlow,
  primaryActionLabel,
  speakerLabelsFor,
  storageLine,
  withLastUsedFirst,
  type KeyValueStorage,
  type LiveClient,
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

/** A live-text session as far as the flow session drives it. */
function fakeLiveClient() {
  const calls: string[] = [];
  const opened: string[] = [];
  const streams: unknown[] = [];
  const snapshot: LiveSnapshot = { status: "connecting", pieces: [], pending: "", started: false };
  const client: LiveClient = {
    open(stepId) {
      opened.push(stepId);
      return {
        getSnapshot: () => snapshot,
        subscribe: () => () => undefined,
        listen: (stream) => void streams.push(stream),
        setRecording: (on) => void calls.push(on ? "recording" : "paused"),
        stop: () => void calls.push("stop"),
        dispose: () => void calls.push("dispose"),
      };
    },
  };
  return { client, calls, opened, streams };
}

async function setup(
  options: {
    store?: RecordingStore;
    storage?: KeyValueStorage;
    getStream?: CaptureDeps["getStream"];
    live?: LiveClient | null;
  } = {},
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
    live: options.live === undefined ? fakeLiveClient().client : options.live,
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

test("Ta bort removes the recording from the device for good and starts over with the details kept", async () => {
  const { session, recorders, store } = await setup();
  session.setContract(audioContract());
  session.selectMode("spela-in");
  session.setDetail("deltagare", ["Anna Berg"]);
  await session.start();
  recorders[0].emit("audio");
  await session.stop();
  await until(() => session.getSnapshot().phase === "ready");
  const { id } = session.getSnapshot().recording!;

  await session.discard();
  assert.equal(session.getSnapshot().phase, "setup");
  assert.equal(session.getSnapshot().recording, null);
  assert.equal(await store.get(id), null);
  assert.deepEqual(await store.listUnsent("user-1"), []);
  assert.deepEqual(session.getSnapshot().details.deltagare, ["Anna Berg"]);
});

test("Ta bort says so when another tab is using the recording, and keeps it", async () => {
  const { session, recorders, store } = await setup();
  session.setContract(audioContract());
  session.selectMode("spela-in");
  await session.start();
  recorders[0].emit("audio");
  await session.stop();
  await until(() => session.getSnapshot().phase === "ready");
  const { id } = session.getSnapshot().recording!;
  assert.ok(await store.lease(id), "another tab takes it, e.g. to send it");

  await session.discard();
  assert.deepEqual(session.getSnapshot().problem, { title: "Inspelningen används i en annan flik." });
  assert.equal(session.getSnapshot().phase, "ready");
  assert.ok(await store.get(id));
});

test("a chosen file is checked against the flow's types and size before anything is sent; a bad pick keeps the earlier file", async () => {
  const probed: string[] = [];
  const { session } = await setup();
  session.setProbeDuration(async (file) => {
    probed.push((file as File).name);
    return 32 * 60_000;
  });
  session.setContract(audioContract());
  session.selectMode("ladda-upp");

  session.chooseFile(new File(["audio"], "mote.mp3", { type: "audio/mpeg" }));
  assert.equal(session.getSnapshot().file?.filename, "mote.mp3");
  await until(() => session.getSnapshot().file?.durationMs != null, "the duration");
  assert.equal(session.getSnapshot().file?.durationMs, 32 * 60_000);
  assert.deepEqual(probed, ["mote.mp3"]);

  session.chooseFile(new File(["text"], "protokoll.pdf", { type: "application/pdf" }));
  assert.deepEqual(session.getSnapshot().problem, {
    title: "Filtypen stöds inte.",
    detail: "Flödet tar emot WebM och MP3.",
  });
  assert.equal(session.getSnapshot().file?.filename, "mote.mp3", "the earlier file stays");

  const big = new File(["x"], "lang.mp3", { type: "audio/mpeg" });
  Object.defineProperty(big, "size", { value: 60 * 1024 * 1024 });
  session.chooseFile(big);
  assert.deepEqual(session.getSnapshot().problem, {
    title: "Filen är större än flödet tar emot (högst 50\u00a0MB).",
    detail: "Välj en kortare inspelning eller dela upp den.",
  });
  assert.equal(session.getSnapshot().file?.filename, "mote.mp3");

  // A file the browser gives no type is judged by its name.
  session.chooseFile(new File(["audio"], "inspelning.flac"));
  assert.equal(session.getSnapshot().problem?.title, "Filtypen stöds inte.");
  session.chooseFile(new File(["audio"], "Intervju.MP3"));
  assert.equal(session.getSnapshot().file?.filename, "Intervju.MP3");
  assert.equal(session.getSnapshot().problem, null);
});

test("accepted types are said in plain words", () => {
  assert.equal(acceptedFormats(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-m4a", "audio/mp4", "audio/webm"]), "MP3, WAV, M4A och WebM");
  assert.equal(acceptedFormats(["audio/amr"]), "AMR");
  assert.equal(acceptedFormats([]), null);
});

test("a stale version refreshes the flow in place and keeps the audio and the details that still fit", async () => {
  let reloads = 0;
  const { session, recorders, store } = await setup();
  session.setContract(audioContract());
  session.setHandlers({
    submit: async () => {
      throw new ApiError(409, "The flow has a newer published version.", null, "flow_run_stale_version");
    },
    reloadFlow: async () => {
      reloads += 1;
      session.setContract(
        audioContract({
          published_flow_version: 4,
          form_fields: [{ name: "deltagare", label: "Deltagare", type: "list" }],
        }),
      );
    },
  });
  session.selectMode("spela-in");
  session.setDetail("deltagare", ["Anna Berg"]);
  await session.start();
  recorders[0].emit("audio");
  await session.stop();
  await until(() => session.getSnapshot().phase === "ready");
  const { id } = session.getSnapshot().recording!;

  assert.equal(await session.createDocument(), false);
  assert.equal(reloads, 1);
  const after = session.getSnapshot();
  assert.deepEqual(after.problem, {
    title: "Flödet har uppdaterats. Kontrollera uppgifterna och skapa dokumentet igen.",
  });
  assert.equal(after.phase, "ready");
  assert.equal(after.recording?.id, id);
  assert.ok(await store.get(id));
  assert.deepEqual(after.details, { deltagare: ["Anna Berg"] });
});

test("a flow that is no longer published says so, with a way back, and the recording stays", async () => {
  const { session, recorders } = await setup();
  session.setContract(audioContract());
  session.setDetail("motesnamn", "KS");
  session.setHandlers({
    submit: async () => {
      throw new ApiError(404, "Flow not found.", null, "flow_not_found");
    },
  });
  session.selectMode("spela-in");
  await session.start();
  recorders[0].emit("audio");
  await session.stop();
  await until(() => session.getSnapshot().phase === "ready");
  assert.equal(await session.createDocument(), false);
  assert.deepEqual(session.getSnapshot().problem, {
    title: "Flödet är inte längre tillgängligt.",
    detail: "Inspelningen finns kvar. Spara den som fil om du vill behålla den.",
    back: true,
  });
  assert.equal(session.getSnapshot().phase, "ready");
});

test("Strömma streams live text beside the recording: pause, a lost microphone and stop reach it; Spela in opens none", async () => {
  const live = fakeLiveClient();
  const { session, streams, recorders } = await setup({ live: live.client });
  session.setContract(audioContract());
  assert.equal(session.getSnapshot().mode, "stromma");
  await session.start();
  assert.deepEqual(live.opened, ["step-audio"], "one live session for the audio step");
  assert.deepEqual(live.streams, [streams[0]], "the recorder's own microphone stream");
  assert.ok(session.getSnapshot().live, "the page reads the draft from it");

  session.togglePause();
  session.togglePause();
  streams[0].track.dispatchEvent(new Event("ended")); // a phone call takes the microphone
  await until(() => session.getSnapshot().phase === "interrupted", "the interruption");
  await session.continueRecording();
  assert.deepEqual(live.streams, [streams[0], streams[1]], "the new microphone stream feeds live text");
  recorders[1].emit("audio");
  await session.stop();
  await until(() => session.getSnapshot().phase === "ready");
  assert.deepEqual(live.calls, ["recording", "paused", "recording", "paused", "recording", "stop"]);

  const spelaIn = fakeLiveClient();
  const other = await setup({ live: spelaIn.client });
  other.session.setContract(audioContract());
  other.session.selectMode("spela-in");
  await other.session.start();
  assert.deepEqual(spelaIn.opened, []);
});

test("a microphone that cannot start leaves no live session behind", async () => {
  const live = fakeLiveClient();
  const { session } = await setup({
    live: live.client,
    getStream: async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    },
  });
  session.setContract(audioContract());
  await session.start();
  assert.deepEqual(live.calls, ["dispose"]);
  assert.equal(session.getSnapshot().live, null);
});
