import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, type RunContract } from "./api";
import { openRecordingStore, type RecordingStore } from "./recording-store";
import { createOnlineStatus } from "./online-status";
import { submitRecording } from "./submit-run";
import type { LiveSnapshot } from "./live-transcriber";
import type { CaptureDeps } from "./recording-session";
import {
  FlowSession,
  availableModes,
  acceptedFormats,
  fileAccept,
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
  const snapshot: LiveSnapshot = { status: "connecting", pieces: [], pending: "", started: false, complete: false };
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

test("a recording keeps each file within the time the contract gives Eneo's audio, and without one only bytes count", async (t) => {
  const [audio] = audioContract().steps_requiring_input!;
  const recordFor = async (max_duration_seconds: number | null) => {
    const { session } = await setup();
    t.after(() => session.dispose());
    session.setContract(
      audioContract({ steps_requiring_input: [{ ...audio, max_files: 1, max_file_size_bytes: 10 ** 12, max_duration_seconds }] }),
    );
    session.selectMode("spela-in");
    await session.start();
    return session.capture.getSnapshot().remainingMs!;
  };
  const timed = await recordFor(90 * 60);
  assert.ok(timed <= 89 * 60_000 && timed > 89 * 60_000 - 10_000, `${timed} ms: bytes alone would allow days`);
  assert.ok((await recordFor(null)) > 24 * 3_600_000, "no time limit: the bytes decide, as before");
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

test("speaker labels: the flow's default in every mode, Strömma included, and an explicit choice survives mode changes", async () => {
  const option = { selectable: true, required: false, default: true };
  assert.equal(speakerLabelsFor(option, null), true);
  assert.equal(speakerLabelsFor({ ...option, default: false }, null), false);
  assert.equal(speakerLabelsFor(option, false), false);
  assert.equal(speakerLabelsFor({ ...option, selectable: false }, true), null, "not offered: nothing is sent");
  assert.equal(speakerLabelsFor(null, null), null);

  const { session } = await setup();
  session.setContract(audioContract());
  assert.equal(session.getSnapshot().mode, "stromma", "Strömma is selected first");
  assert.equal(session.getSnapshot().speakerLabels, true, "the flow promises speaker labels, so Strömma keeps them");
  session.setSpeakerLabels(false);
  session.selectMode("ladda-upp");
  assert.equal(session.getSnapshot().speakerLabels, false, "the explicit choice is kept");
  session.setSpeakerLabels(true);
  session.selectMode("stromma");
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

test("a file the flow marks optional may be left out: Skapa dokument sends the details alone; a required one still waits", async () => {
  const sent: Array<Parameters<Parameters<FlowSession["setHandlers"]>[0]["submit"]>[0]> = [];
  const { session } = await setup();
  session.setHandlers({ submit: async (request) => void sent.push(request) });
  const step = audioContract().steps_requiring_input![0];
  session.setContract(audioContract({ steps_requiring_input: [{ ...step, required: false }] }));
  session.selectMode("ladda-upp");
  assert.equal(await session.createDocument(), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].input, null);

  session.setContract(audioContract());
  session.selectMode("ladda-upp");
  assert.equal(await session.createDocument(), false);
  assert.equal(sent.length, 1, "a required file is never skipped");
});

test("an optional file never turns a send from the unsent list into an empty run while a recording is starting", async () => {
  const sent: unknown[] = [];
  let grant: (stream: MediaStream) => void = () => undefined;
  const { session, store } = await setup({ getStream: () => new Promise((resolve) => (grant = resolve)) });
  session.setHandlers({ submit: async (request) => void sent.push(request) });
  const step = audioContract().steps_requiring_input![0];
  session.setContract(audioContract({ steps_requiring_input: [{ ...step, required: false }] }));
  session.selectMode("spela-in");
  const starting = session.start();
  await until(() => session.getSnapshot().phase === "starting");
  const unsent = await store.create({
    ownerId: "user-1",
    flowId: "flow-1",
    flowName: "Nämndmöte till rapport",
    stepId: "step-audio",
    inputMode: "record",
    mimeType: "audio/webm",
  });
  session.adopt(unsent);
  assert.equal(await session.createDocument(), false);
  assert.equal(sent.length, 0);
  grant(new FakeStream() as unknown as MediaStream);
  await starting;
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

test("a part longer than Eneo takes is not sent, whatever the page's copy of the recording says: it stays on the device, with why and how to keep it", async () => {
  const { session, store } = await setup();
  const [audio] = audioContract().steps_requiring_input!;
  const contract = audioContract({ steps_requiring_input: [{ ...audio, max_duration_seconds: 90 * 60 }] });
  session.setContract(contract);
  let uploads = 0;
  session.setHandlers({
    submit: async ({ input, payload }) => {
      if (input?.kind !== "recording") return;
      await submitRecording(
        store,
        input.recording.id,
        { flowId: "flow-1", contract, stepId: "step-audio", inputPayload: payload, online: createOnlineStatus() },
        { upload: async () => ({ id: `file-${++uploads}` }), startRun: async () => ({ id: "run-1", flow_id: "flow-1", status: "queued" }) },
      );
    },
  });
  const recording = await store.create({
    ownerId: "user-1",
    flowId: "flow-1",
    flowName: "Nämndmöte till rapport",
    stepId: "step-audio",
    inputMode: "record",
    mimeType: "audio/webm",
  });
  await store.startPart(recording.id);
  await store.append(recording.id, 0, new Blob(["x"]), 60_000);
  await store.setState(recording.id, "stopped");
  session.adopt((await store.get(recording.id))!); // the page's copy: one minute
  // Meanwhile another tab recorded on, past the flow's 90 minutes (a page the browser suspended past its handover).
  await store.append(recording.id, 0, new Blob(["y"]), 91 * 60_000);
  store.release(recording.id);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(await session.createDocument(), false);
  assert.equal(uploads, 0, "nothing uploaded for Eneo to take and refuse later");
  assert.equal(
    session.getSnapshot().problem?.title,
    "Inspelningen är för lång för en fil: en del är längre än flödet tar emot (1 h 30 min). Välj Spara som fil för att behålla den.",
  );
  assert.equal((await store.get(recording.id))?.state, "stopped", "kept on the device, not sealed");
});

test("a recording whose run request Eneo may already have answered is sent again as it was, whatever the details say now", async () => {
  const sent: Array<Parameters<Parameters<FlowSession["setHandlers"]>[0]["submit"]>[0]> = [];
  const { session, store } = await setup();
  session.setHandlers({ submit: async (request) => void sent.push(request) });
  session.setContract(audioContract());
  session.setDetail("motesnamn", ""); // a reload started the details over, and emptied a required one
  const unsent = await store.create({
    ownerId: "user-1",
    flowId: "flow-1",
    flowName: "Nämndmöte till rapport",
    stepId: "step-audio",
    inputMode: "record",
    mimeType: "audio/webm",
  });
  await store.startSubmission(unsent.id, { body: { expected_flow_version: 3 }, idempotencyKey: `flow-run:recording:${unsent.id}` });
  session.adopt((await store.get(unsent.id))!);
  assert.equal(await session.createDocument(), true);
  assert.equal(sent.length, 1, "the stored request carries its own details");
  assert.deepEqual(session.getSnapshot().invalid, []);
});

test("after a send whose answer never came, the stored request goes again even when a required detail was cleared since", async () => {
  const { session, store, recorders } = await setup();
  let sends = 0;
  session.setHandlers({
    submit: async (request) => {
      sends += 1;
      if (sends > 1 || request.input?.kind !== "recording") return;
      // The send asked Eneo for the run, and the answer was lost.
      await store.startSubmission(request.input.recording.id, { body: { expected_flow_version: 3 }, idempotencyKey: "key" });
      throw new TypeError("Failed to fetch");
    },
  });
  session.setContract(audioContract());
  session.selectMode("spela-in");
  await session.start();
  recorders[0].emit("audio");
  await session.stop();
  await until(() => session.getSnapshot().phase === "ready");
  assert.equal(await session.createDocument(), false);
  assert.equal(session.getSnapshot().recording?.state, "uploaded", "shown as sealed, so no Fortsätt spela in");

  session.setDetail("motesnamn", "");
  assert.equal(await session.createDocument(), true);
  assert.equal(sends, 2, "the stored request carries its own details");
  assert.deepEqual(session.getSnapshot().invalid, []);
});

test("a page left while Skapa dokument reads the store sends nothing, and the recording stays", async () => {
  const { session, store, recorders } = await setup();
  let sends = 0;
  session.setHandlers({ submit: async () => void (sends += 1) });
  session.setContract(audioContract());
  session.selectMode("spela-in");
  await session.start();
  recorders[0].emit("audio");
  await session.stop();
  await until(() => session.getSnapshot().phase === "ready");
  const { id } = session.getSnapshot().recording!;

  const get = store.get.bind(store);
  let read: (() => void) | null = null;
  store.get = (recordingId) => new Promise((resolve) => (read = () => resolve(get(recordingId))));
  const creating = session.createDocument();
  await until(() => read !== null, "the store read");
  session.dispose(); // the page goes, and its cleanup runs
  read!();
  assert.equal(await creating, false);
  assert.equal(sends, 0, "no run is asked for");
  store.get = get;
  assert.notEqual(await store.get(id), null, "the recording stays on the device");
});

test("republished with a new required detail: the form asks for it before Eneo is asked again, then one request goes under the key", async () => {
  const { session, store, recorders } = await setup();
  let contract = audioContract();
  const requests: Array<{ body: Record<string, unknown>; key: string }> = [];
  let uploads = 0;
  session.setHandlers({
    submit: async ({ input, payload }) => {
      if (input?.kind !== "recording") return;
      await submitRecording(
        store,
        input.recording.id,
        { flowId: "flow-1", contract, stepId: "step-audio", inputPayload: payload, online: createOnlineStatus() },
        {
          upload: async () => ({ id: `file-${++uploads}` }),
          startRun: async (_flowId, body, key) => {
            requests.push({ body, key });
            // Published again with a required "datum": the old version is refused.
            if (body.expected_flow_version !== 4) throw new ApiError(409, "stale", null, "flow_run_stale_version");
            return { id: "run-1", flow_id: "flow-1", status: "queued" };
          },
        },
      );
    },
    reloadFlow: async () => {
      contract = audioContract({
        published_flow_version: 4,
        form_fields: [...(audioContract().form_fields ?? []), { name: "datum", label: "Datum", type: "text", required: true }],
      });
      session.setContract(contract);
    },
  });
  session.setContract(contract);
  session.selectMode("spela-in");
  await session.start();
  recorders[0].emit("audio");
  await session.stop();
  await until(() => session.getSnapshot().phase === "ready");
  const { id } = session.getSnapshot().recording!;

  assert.equal(await session.createDocument(), false);
  assert.equal(
    session.getSnapshot().problem?.title,
    "Flödet har uppdaterats sedan sidan öppnades. Kontrollera uppgifterna och välj Skapa dokument igen.",
  );
  assert.equal(await session.createDocument(), false, "the refreshed form asks for the new detail");
  assert.deepEqual(session.getSnapshot().invalid, ["datum"]);
  assert.equal(requests.length, 1, "Eneo is not asked meanwhile");

  session.setDetail("datum", "2026-09-23");
  assert.equal(await session.createDocument(), true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].key, `flow-run:recording:${id}`, "the same key");
  assert.equal(requests[1].body.expected_flow_version, 4);
  assert.equal(uploads, 1, "the audio went up once");
});

test("after a cleanup the page set up again (React Strict Mode) still makes documents", async () => {
  const { session, recorders } = await setup();
  let sends = 0;
  session.setHandlers({ submit: async () => void (sends += 1) });
  session.setContract(audioContract());
  session.dispose(); // Strict Mode runs the effect's cleanup once, then sets it up again with the same session
  session.selectMode("spela-in");
  await session.start();
  recorders[0].emit("audio");
  await session.stop();
  await until(() => session.getSnapshot().phase === "ready");
  assert.equal(await session.createDocument(), true);
  assert.equal(sends, 1);
});

test("a recording Eneo already has says so, has the earlier runs read again, and stays to be deleted", async () => {
  const { session, recorders } = await setup();
  let refreshed = 0;
  session.setHandlers({
    submit: async () => {
      throw new Error("Inspelningen har redan skickats. Körningen finns under Tidigare körningar.");
    },
    refreshEarlierRuns: () => void (refreshed += 1),
  });
  session.setContract(audioContract());
  session.selectMode("spela-in");
  await session.start();
  recorders[0].emit("audio");
  await session.stop();
  await until(() => session.getSnapshot().phase === "ready");

  assert.equal(await session.createDocument(), false);
  const { phase, problem } = session.getSnapshot();
  assert.equal(phase, "ready", "the recording stays, to be deleted from the device");
  assert.deepEqual(problem, { title: "Inspelningen har redan skickats. Körningen finns under Tidigare körningar.", sent: true });
  assert.equal(refreshed, 1, "the earlier runs are read again, with the run Eneo has");
});

test("details typed before a lost login come back after it for the same person, not another; a sent document clears them", async () => {
  const data = new Map<string, string>();
  const drafts = {
    get length() {
      return data.size;
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
  const session = (ownerId: string, flowId = "flow-1") =>
    new FlowSession({
      flowId,
      flowName: "Nämndmöte till rapport",
      ownerId,
      openStore: () => openRecordingStore({}),
      captureDeps: { getStream: async () => new FakeStream() as unknown as MediaStream, createRecorder: () => new FakeRecorder() as unknown as MediaRecorder },
      pickMimeType: () => "audio/webm;codecs=opus",
      storage: memoryStorage(),
      drafts,
    });
  const before = session("user-1");
  before.setContract(audioContract());
  before.setDetail("motesnamn", "Byggnadsnämnden");
  before.setDetail("deltagare", ["Anna Berg"]);
  before.dispose(); // the page reloaded after the login was lost

  const after = session("user-1");
  after.setContract(null); // the page sets the flow's contract once it has loaded
  after.setContract(audioContract());
  assert.equal(after.getSnapshot().details.motesnamn, "Byggnadsnämnden");
  assert.deepEqual(after.getSnapshot().details.deltagare, ["Anna Berg"]);
  const other = session("user-2");
  other.setContract(audioContract());
  assert.equal(other.getSnapshot().details.motesnamn, "Kommunstyrelsen", "another person starts from the flow's defaults");
  const otherFlow = session("user-1", "flow-2");
  otherFlow.setContract(audioContract());
  assert.equal(otherFlow.getSnapshot().details.motesnamn, "Kommunstyrelsen", "and another flow too");

  after.setHandlers({ submit: async () => {} });
  after.selectMode("ladda-upp");
  after.chooseFile(new File(["audio"], "mote.mp3", { type: "audio/mpeg" }));
  assert.equal(await after.createDocument(), true);
  const again = session("user-1");
  again.setContract(audioContract());
  assert.equal(again.getSnapshot().details.motesnamn, "Kommunstyrelsen", "sent: the draft is gone");
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

test("Fortsätt spela in after Stoppa records on in a new part of the same recording; the next stop shows the whole", async () => {
  const { session, recorders } = await setup();
  session.setContract(audioContract());
  session.selectMode("spela-in");
  await session.start();
  recorders[0].emit("first");
  await session.stop();
  await until(() => session.getSnapshot().phase === "ready");
  const first = session.getSnapshot().recording!;

  await session.continueStopped();
  assert.equal(session.getSnapshot().phase, "recording");
  assert.equal(session.getSnapshot().recording?.id, first.id, "the same recording");
  assert.equal(recorders.length, 2, "a new part");
  recorders[1].emit("second");
  await session.stop();
  await until(() => session.getSnapshot().phase === "ready");
  const whole = session.getSnapshot().recording!;
  assert.equal(whole.id, first.id);
  assert.equal(whole.parts.length, 2, "the ready state shows both parts, not the first stop's copy");
});

test("once a send of the recording has begun, Fortsätt spela in says why and the ready state stays", async () => {
  const { session, store, recorders } = await setup();
  session.setContract(audioContract());
  session.selectMode("spela-in");
  await session.start();
  recorders[0].emit("audio");
  await session.stop();
  await until(() => session.getSnapshot().phase === "ready");
  await store.setState(session.getSnapshot().recording!.id, "uploading");

  await session.continueStopped();
  const snapshot = session.getSnapshot();
  assert.equal(snapshot.phase, "ready");
  assert.equal(snapshot.problem?.title, "Inspelningen skickas eller har redan skickats och kan inte fortsätta.");
  assert.equal(recorders.length, 1, "no new part");
});

test("a Strömma recording continued after a reload or after Stoppa streams live text again", async () => {
  const live = fakeLiveClient();
  const { session, store, streams, recorders } = await setup({ live: live.client });
  session.setContract(audioContract());
  const earlier = await store.create({
    ownerId: "user-1",
    flowId: "flow-1",
    flowName: "Nämndmöte till rapport",
    stepId: "step-audio",
    inputMode: "stream",
    mimeType: "audio/webm;codecs=opus",
  });
  await store.startPart(earlier.id);
  await store.append(earlier.id, 0, new Blob(["before the reload"]), 60_000);
  store.release(earlier.id);

  await session.continueCutOff((await store.get(earlier.id))!);
  assert.equal(session.getSnapshot().mode, "stromma");
  assert.ok(session.getSnapshot().live, "live text beside the recording");
  assert.deepEqual(live.streams, [streams[0]]);

  recorders[0].emit("after");
  await session.stop();
  await until(() => session.getSnapshot().phase === "ready");
  await session.continueStopped();
  assert.equal(session.getSnapshot().phase, "recording");
  assert.deepEqual(live.opened, ["step-audio", "step-audio"], "a new live session for the new part");
  assert.deepEqual(live.streams, [streams[0], streams[1]]);
  assert.ok(session.getSnapshot().live);
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
    detail: "Flödet tar emot MP3 och WebM.",
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

test("a document is sent under the type the flow takes, whatever name the browser gave it", async () => {
  const { session } = await setup();
  session.setContract(
    audioContract({
      steps_requiring_input: [
        {
          step_id: "step-doc",
          input_format: "document",
          max_files: 1,
          max_file_size_bytes: 1024,
          accepted_mimetypes: ["text/markdown", "text/plain", "application/pdf"],
        },
      ],
    }),
  );
  session.selectMode("ladda-upp");

  session.chooseFile(new File(["# Plan"], "underlag.md"));
  assert.equal(session.getSnapshot().problem, null, "no type from the browser: the name says Markdown");
  assert.equal(session.getSnapshot().file?.blob.type, "text/markdown", "Eneo refuses a part without the type");

  session.chooseFile(new File(["# Plan"], "Underlag.MD", { type: "text/x-markdown" }));
  assert.equal(session.getSnapshot().file?.blob.type, "text/markdown", "another spelling of a type the flow takes");
  assert.equal(session.getSnapshot().file?.filename, "Underlag.MD");

  session.chooseFile(new File(["%PDF"], "plan.pdf", { type: "application/pdf" }));
  assert.equal(session.getSnapshot().file?.blob.type, "application/pdf");

  session.chooseFile(new File(["img"], "bild.png", { type: "image/png" }));
  assert.deepEqual(session.getSnapshot().problem, {
    title: "Filtypen stöds inte.",
    detail: "Flödet tar emot PDF, text och Markdown.",
  });

  const big = new File(["x"], "stor.pdf", { type: "application/pdf" });
  Object.defineProperty(big, "size", { value: 4096 });
  session.chooseFile(big);
  assert.deepEqual(session.getSnapshot().problem, {
    title: "Filen är större än flödet tar emot (högst 1\u00a0kB).",
    detail: "Välj en mindre fil eller dela upp den.",
  });
});

test("the file chooser offers the flow's types by extension too, so the dialog does not grey out a known file", () => {
  assert.equal(
    fileAccept(["text/markdown", "application/pdf", "application/vnd.ms-excel", "audio/amr"]),
    "text/markdown,.md,.markdown,application/pdf,.pdf,application/vnd.ms-excel,.xls,audio/amr,.amr",
  );
  assert.equal(fileAccept([]), undefined);
  assert.equal(fileAccept(undefined), undefined);
});

test("accepted types are said in plain words", () => {
  assert.equal(acceptedFormats(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-m4a", "audio/mp4", "audio/webm"]), "MP3, WAV, M4A och WebM");
  assert.equal(
    acceptedFormats([
      "text/markdown",
      "text/plain",
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/csv",
      "application/csv",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "application/json",
      "text/xml",
      "application/xml",
    ]),
    "Word, PDF, PowerPoint, Excel, CSV, text, Markdown, JSON och XML",
    "documents by the names people know, once each, in one order",
  );
  assert.equal(acceptedFormats(["audio/amr"]), ".amr", "an unknown type by its file extension, never an uppercased subtype");
  assert.equal(acceptedFormats(["application/x-yaml", "application/pdf"]), "PDF och .yaml");
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
    title: "Flödet har uppdaterats sedan sidan öppnades. Kontrollera uppgifterna och välj Skapa dokument igen.",
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

test("live text that cannot even be set up never keeps the recording from starting; the sheet says so", async () => {
  const { session, recorders } = await setup({
    live: {
      open() {
        throw new DOMException("The browser has no audio for this page.", "NotSupportedError");
      },
    },
  });
  session.setContract(audioContract());
  assert.equal(session.getSnapshot().mode, "stromma");
  await session.start();
  assert.equal(session.getSnapshot().phase, "recording", "the recording runs");
  assert.equal(recorders.length, 1);
  assert.equal(session.getSnapshot().live?.getSnapshot().status, "unavailable", "the preview says it could not start");
});

test("a flow its owner must republish says so in Swedish, with a way back, and the recording stays", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const { session, recorders } = await setup();
  session.setContract(audioContract());
  session.setDetail("motesnamn", "KS");
  session.setHandlers({
    submit: async () => {
      throw new ApiError(
        409,
        "Step 1 (Transkribera ljud): Assistant snapshot is missing. Republish the flow before running it.",
        null,
        "flow_assistant_snapshot_republish_required",
      );
    },
  });
  session.selectMode("spela-in");
  await session.start();
  recorders[0].emit("audio");
  await session.stop();
  await until(() => session.getSnapshot().phase === "ready");
  assert.equal(await session.createDocument(), false);
  assert.deepEqual(session.getSnapshot().problem, {
    title: "Flödet behöver publiceras om av den som ansvarar för det innan det kan användas.",
    detail: "Inspelningen finns kvar. Spara den som fil om du vill behålla den.",
    back: true,
  });
});
