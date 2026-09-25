import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import {
  ApiError,
  deriveRunIdempotencyKey,
  startRun,
  uploadStepRuntimeFile,
  type FlowRunPublic,
  type FlowRunStep,
  type Json,
  type RunContract,
} from "./api";
import { fakeWebLocks } from "./fake-web-locks";
import { createOnlineStatus, type OnlineTarget } from "./online-status";
import { openRecordingStore, type NewRecording, type RecordingStore } from "./recording-store";
import {
  retryFailedRun,
  startAgain,
  startAgainRequest,
  submitRecording,
  submitRun,
  withRetry,
  type RetryWait,
  type SubmitDeps,
  type SubmitParams,
} from "./submit-run";

const apiError = (status: number, code?: string) => new ApiError(status, `HTTP ${status}`, null, code);
const uploadNetworkError = () => new ApiError(0, "Nätverksfel vid uppladdning.", null, "network_error");
const fetchFailed = () => new TypeError("Failed to fetch");
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function until(condition: () => boolean) {
  for (let i = 0; i < 1_000 && !condition(); i += 1) await settle();
  assert.ok(condition(), "never happened");
}

function fakeBrowser(onLine: boolean) {
  const target = Object.assign(new EventTarget(), { navigator: { onLine } });
  return {
    target: target as OnlineTarget,
    go(online: boolean) {
      target.navigator.onLine = online;
      target.dispatchEvent(new Event(online ? "online" : "offline"));
    },
  };
}

const contract: RunContract = {
  flow_id: "flow-1",
  published_flow_version: 3,
  steps_requiring_input: [
    { step_id: "step-audio", input_format: "audio", max_files: 10, max_file_size_bytes: 1_024 },
  ],
};

const queuedRun: FlowRunPublic = { id: "run-1", flow_id: "flow-1", status: "queued" };

const params = (overrides: Partial<SubmitParams> = {}): SubmitParams => ({
  flowId: "flow-1",
  contract,
  stepId: "step-audio",
  files: [],
  inputPayload: {},
  online: createOnlineStatus(fakeBrowser(true).target),
  ...overrides,
});

test("uploads retry network failures, 408, 429 and 5xx, waiting 1 s doubling to 60 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const failures = [
    uploadNetworkError(),
    apiError(408, "stalled"),
    apiError(429),
    apiError(500),
    apiError(502, "upstream_unreachable"),
    apiError(503),
    apiError(504),
    fetchFailed(),
  ];
  let calls = 0;
  const waits: number[] = [];
  const result = withRetry(
    async () => {
      const failure = failures[calls];
      calls += 1;
      if (failure) throw failure;
      return "file-1";
    },
    { online: params().online, onWait: (wait) => void (wait && waits.push(wait.retryAt - Date.now())) },
  );

  await settle();
  t.mock.timers.tick(999);
  await settle();
  assert.equal(calls, 1, "nothing is retried before the wait is over");
  t.mock.timers.tick(1);
  for (let i = 1; i < failures.length; i += 1) {
    await until(() => waits.length === i + 1);
    t.mock.timers.tick(waits[i]);
  }
  assert.equal(await result, "file-1");
  assert.equal(calls, failures.length + 1);
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
});

test("any other 4xx stops at once with its typed error, and so does a cancelled upload", async () => {
  const failures = [
    apiError(400, "flow_run_file_not_accessible"),
    apiError(401),
    apiError(403, "insufficient_scope"),
    apiError(404),
    apiError(409, "flow_run_idempotency_conflict"),
    apiError(413),
    apiError(415),
    apiError(422),
    new ApiError(0, "Uppladdningen avbröts.", null, "upload_aborted"),
  ];
  for (const failure of failures) {
    let calls = 0;
    // A wrong retry would wait; cancelling it makes the test fail at once instead of hanging.
    const controller = new AbortController();
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw failure;
        },
        { ...params(), signal: controller.signal, onWait: (wait) => wait && controller.abort() },
      ),
      (error) => error === failure,
    );
    assert.equal(calls, 1, `${failure.status} ${failure.code ?? ""}`);
  }
});

test("offline, a send waits for the connection and continues by itself when it returns", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const browser = fakeBrowser(false);
  const online = createOnlineStatus(browser.target);
  const waits: RetryWait[] = [];
  let calls = 0;
  const result = withRetry(
    async () => {
      calls += 1;
      if (!browser.target.navigator.onLine) throw uploadNetworkError();
      return "file-1";
    },
    { online, onWait: (wait) => void (wait && waits.push(wait)) },
  );

  await until(() => waits.length === 1);
  assert.equal(online.online, false);
  browser.go(true);
  await until(() => calls === 2);
  assert.equal(await result, "file-1", "sent as soon as the connection is back, before the backoff ends");
});

test("'Försök nu' retries at once, and cancelling ends the wait", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const notice: { wait: RetryWait | null } = { wait: null };
  const onWait = (wait: RetryWait | null) => void (notice.wait = wait);
  let calls = 0;
  const result = withRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw apiError(503);
      return "file-1";
    },
    { ...params(), onWait },
  );
  await until(() => notice.wait !== null);
  notice.wait?.retryNow();
  assert.equal(await result, "file-1");
  assert.equal(calls, 2);
  assert.equal(notice.wait, null, "the retry notice goes away when the wait ends");

  const controller = new AbortController();
  const cancelled = withRetry(
    async () => {
      throw apiError(503);
    },
    { ...params(), signal: controller.signal, onWait },
  );
  await until(() => notice.wait !== null);
  controller.abort();
  await assert.rejects(cancelled, (error: ApiError) => error.code === "upload_aborted");
  assert.equal(notice.wait, null);

  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort();
  calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw uploadNetworkError();
      },
      { ...params(), signal: alreadyCancelled.signal },
    ),
  );
  assert.equal(calls, 0, "a cancelled send sends nothing");
});

test("run creation retries network failures with the same idempotency key", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const keys: string[] = [];
  const bodies: Json[] = [];
  const deps: SubmitDeps = {
    upload: async () => ({ id: "file-1" }),
    startRun: async (_flowId, body, key) => {
      keys.push(key);
      bodies.push(body);
      if (keys.length < 3) throw fetchFailed();
      return queuedRun;
    },
  };
  const run = submitRun(
    params({
      files: [{ blob: new Blob(["audio"]), filename: "inspelning.webm" }],
      inputPayload: { motesnamn: "KS" },
    }),
    deps,
  );
  await until(() => keys.length === 1);
  t.mock.timers.tick(1_000);
  await until(() => keys.length === 2);
  t.mock.timers.tick(2_000);

  assert.equal((await run).id, "run-1");
  assert.equal(keys.length, 3);
  assert.equal(new Set(keys).size, 1);
  assert.deepEqual(bodies[0], {
    expected_flow_version: 3,
    step_inputs: { "step-audio": { file_ids: ["file-1"] } },
    input_payload_json: { motesnamn: "KS" },
  });
  assert.equal(keys[0], await deriveRunIdempotencyKey({ flowId: "flow-1", expectedFlowVersion: 3, body: bodies[0] }));
});

/** The browser's XMLHttpRequest where it matters here: abort() fires "abort" before it returns. */
class FakeXhr {
  static made: FakeXhr[] = [];
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  withCredentials = false;
  status = 0;
  responseText = "";
  constructor() {
    FakeXhr.made.push(this);
  }
  open() {}
  setRequestHeader() {}
  send() {}
  getResponseHeader(name: string) {
    return name.toLowerCase() === "content-type" ? "application/json" : null;
  }
  abort() {
    this.onabort?.();
  }
  answer(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

test("an upload the server never answers times out, and the timeout is retried", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const browserXhr = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
  FakeXhr.made = [];
  try {
    const policy = { min_timeout_seconds: 5, seconds_per_mebibyte: 1, max_timeout_seconds: 60, idle_timeout_seconds: 5 };
    const run = submitRun(
      params({
        contract: { ...contract, runtime_upload_policy: policy },
        files: [{ blob: new Blob(["audio"]), filename: "inspelning.webm" }],
      }),
      { upload: uploadStepRuntimeFile, startRun: async () => queuedRun },
    );
    await until(() => FakeXhr.made.length === 1);
    t.mock.timers.tick(5_000); // "not_started": the server never took the upload
    await settle();
    t.mock.timers.tick(1_000);
    await until(() => FakeXhr.made.length === 2);
    FakeXhr.made[1].answer(201, { id: "file-1" });
    assert.equal((await run).id, "run-1");
  } finally {
    globalThis.XMLHttpRequest = browserXhr;
  }
});

test("a send cancelled as its upload finishes starts no run, and cancelling stops a run request in flight", async () => {
  const cancel = new AbortController();
  let runs = 0;
  await assert.rejects(
    submitRun(params({ files: [{ blob: new Blob(["audio"]), filename: "inspelning.webm" }], signal: cancel.signal }), {
      upload: async () => {
        cancel.abort(); // "Avbryt" as the last byte goes up
        return { id: "file-1" };
      },
      startRun: async () => {
        runs += 1;
        return queuedRun;
      },
    }),
  );
  assert.equal(runs, 0);

  const later = new AbortController();
  let asked: AbortSignal | undefined;
  const sending = submitRun(params({ signal: later.signal }), {
    upload: async () => ({ id: "file-1" }),
    startRun: (_flowId, _body, _key, signal) =>
      new Promise((_resolve, reject) => {
        asked = signal;
        signal?.addEventListener("abort", () => reject(new DOMException("The request was aborted.", "AbortError")));
      }),
  });
  await until(() => asked !== undefined);
  later.abort();
  await assert.rejects(sending, { name: "AbortError" });

  // The real request hands the signal to fetch.
  const browserFetch = globalThis.fetch;
  let fetched: AbortSignal | null | undefined;
  globalThis.fetch = async (_input, init) => {
    fetched = init?.signal;
    return new Response(JSON.stringify(queuedRun), { status: 201, headers: { "content-type": "application/json" } });
  };
  try {
    const signal = new AbortController().signal;
    await startRun("flow-1", { expected_flow_version: 3 }, "flow-run:recording:r1", signal);
    assert.equal(fetched, signal);
  } finally {
    globalThis.fetch = browserFetch;
  }
});

test("files are uploaded one at a time as the ordered files of one run, skipping those already uploaded", async () => {
  const events: string[] = [];
  const reported: Array<[number, string]> = [];
  let body: Json | null = null;
  const deps: SubmitDeps = {
    upload: async (_flowId, stepId, _blob, filename) => {
      assert.equal(stepId, "step-audio");
      events.push(`start ${filename}`);
      await settle();
      events.push(`end ${filename}`);
      return { id: `id-${filename}` };
    },
    startRun: async (_flowId, runBody) => {
      body = runBody;
      return queuedRun;
    },
  };
  await submitRun(
    params({
      files: [
        { blob: new Blob(["1"]), filename: "del-1.webm", fileId: "file-a" },
        { blob: new Blob(["2"]), filename: "del-2.webm" },
        { blob: new Blob(["3"]), filename: "del-3.webm" },
      ],
      onUploaded: (index, fileId) => void reported.push([index, fileId]),
    }),
    deps,
  );
  assert.deepEqual(events, ["start del-2.webm", "end del-2.webm", "start del-3.webm", "end del-3.webm"]);
  assert.deepEqual(reported, [
    [1, "id-del-2.webm"],
    [2, "id-del-3.webm"],
  ]);
  assert.deepEqual(body, {
    expected_flow_version: 3,
    step_inputs: { "step-audio": { file_ids: ["file-a", "id-del-2.webm", "id-del-3.webm"] } },
  });
});

test("files the step cannot take stop the send before anything is uploaded", async () => {
  let uploads = 0;
  const deps: SubmitDeps = {
    upload: async () => {
      uploads += 1;
      return { id: "file" };
    },
    startRun: async () => queuedRun,
  };
  await assert.rejects(
    submitRun(params({ files: [{ blob: new Blob(["x".repeat(2_048)]), filename: "stor.webm" }] }), deps),
    { message: "Filen är för stor (2\u00a0kB). Max: 1\u00a0kB." },
  );
  const twoFiles: RunContract = {
    ...contract,
    steps_requiring_input: [{ step_id: "step-audio", input_format: "audio", max_files: 2 }],
  };
  const threeParts = ["1", "2", "3"].map((n) => ({ blob: new Blob([n]), filename: `del-${n}.webm` }));
  await assert.rejects(submitRun(params({ contract: twoFiles, files: threeParts }), deps), /3 delar.*2 filer/);
  assert.equal(uploads, 0);
});

const meeting: NewRecording = {
  ownerId: "user-1",
  flowId: "flow-1",
  flowName: "Nämndmöte till rapport",
  stepId: "step-audio",
  inputMode: "record",
  mimeType: "audio/webm;codecs=opus",
};

/** A recording made and stopped in a tab, whose lease has ended. */
async function stoppedRecording(store: RecordingStore, parts: string[][]) {
  const recording = await store.create(meeting);
  for (const chunks of parts) {
    const index = await store.startPart(recording.id);
    for (const chunk of chunks) await store.append(recording.id, index, new Blob([chunk]), 1_000);
  }
  await store.setState(recording.id, "stopped");
  store.release(recording.id);
  await settle();
  return recording;
}

test("sending a recording uploads its parts and deletes the local copy only once Eneo accepted the run", async () => {
  const store = await openRecordingStore({});
  const recording = await stoppedRecording(store, [["a1", "a2"], ["b1"]]);
  const contents: string[] = [];
  const statesSeen: string[] = [];
  const deps: SubmitDeps = {
    upload: async (_flowId, _stepId, blob) => {
      contents.push(await blob.text());
      statesSeen.push((await store.get(recording.id))?.state ?? "gone");
      return { id: `file-${contents.length}` };
    },
    startRun: async (_flowId, body) => {
      statesSeen.push((await store.get(recording.id))?.state ?? "gone");
      assert.deepEqual(body.step_inputs, { "step-audio": { file_ids: ["file-1", "file-2"] } });
      return queuedRun;
    },
  };

  const run = await submitRecording(store, recording.id, params(), deps);
  assert.equal(run.id, "run-1");
  assert.deepEqual(contents, ["a1a2", "b1"]);
  assert.deepEqual(statesSeen, ["uploading", "uploading", "uploaded"]);
  assert.equal(await store.get(recording.id), null);
  assert.deepEqual(await store.listUnsent("user-1"), []);

  // Eneo has the run even if the device cannot tidy up afterwards.
  const another = await stoppedRecording(store, [["c"]]);
  store.accept = async () => {
    throw new DOMException("Connection to Indexed Database server lost", "UnknownError");
  };
  assert.equal((await submitRecording(store, another.id, params(), { ...deps, startRun: async () => queuedRun })).id, "run-1");
});

test("a run request Eneo may already have answered goes again as it was, even with a part past the time limit", async () => {
  const store = await openRecordingStore({});
  const recording = await store.create(meeting);
  await store.startPart(recording.id);
  await store.append(recording.id, 0, new Blob(["a"]), 91 * 60_000);
  const request = { body: { expected_flow_version: 3 }, idempotencyKey: `flow-run:recording:${recording.id}` };
  await store.startSubmission(recording.id, request);
  store.release(recording.id);
  await settle();
  const timed: RunContract = { ...contract, steps_requiring_input: [{ ...contract.steps_requiring_input![0], max_duration_seconds: 90 * 60 }] };
  const asked: string[] = [];
  const run = await submitRecording(store, recording.id, params({ contract: timed }), {
    upload: async () => assert.fail("nothing is uploaded again"),
    startRun: async (_flowId, _body, key) => {
      asked.push(key!);
      return queuedRun;
    },
  });
  assert.equal(run.id, "run-1", "the run its first send may have made");
  assert.deepEqual(asked, [request.idempotencyKey]);
});

test("a send that stops keeps the recording and its uploaded parts; the next send uploads only the rest", async () => {
  const store = await openRecordingStore({});
  const recording = await stoppedRecording(store, [["a"], ["b"]]);
  const stops: SubmitDeps = {
    upload: async (_flowId, _stepId, blob) => {
      if ((await blob.text()) === "b") throw apiError(413);
      return { id: "file-a" };
    },
    startRun: async () => queuedRun,
  };
  await assert.rejects(submitRecording(store, recording.id, params(), stops), (error: ApiError) => error.status === 413);
  const kept = await store.get(recording.id);
  // Sealed from its first send: never "stopped", so never continued, whatever the send's end.
  assert.deepEqual([kept?.state, kept?.parts.map((p) => p.fileId)], ["uploading", ["file-a", null]]);
  assert.equal((await store.listUnsent("user-1")).length, 1);

  const uploaded: string[] = [];
  let stepInputs: unknown = null;
  await submitRecording(store, recording.id, params(), {
    upload: async (_flowId, _stepId, blob) => {
      uploaded.push(await blob.text());
      return { id: "file-b" };
    },
    startRun: async (_flowId, body) => {
      stepInputs = body.step_inputs;
      return queuedRun;
    },
  });
  assert.deepEqual(uploaded, ["b"]);
  assert.deepEqual(stepInputs, { "step-audio": { file_ids: ["file-a", "file-b"] } });
  assert.equal(await store.get(recording.id), null);
});

test("a run Eneo refuses forgets the uploaded parts, so the next send uploads them again", async () => {
  const store = await openRecordingStore({});
  const recording = await stoppedRecording(store, [["a"]]);
  await assert.rejects(
    submitRecording(store, recording.id, params(), {
      upload: async () => ({ id: "file-a" }),
      startRun: async () => {
        throw apiError(400, "flow_run_file_not_accessible");
      },
    }),
  );
  const kept = await store.get(recording.id);
  assert.deepEqual([kept?.state, kept?.parts[0].fileId], ["uploading", null]);
  assert.equal((await store.listUnsent("user-1")).length, 1);

  // Refused means no run: the next send asks anew, with the details as they are then.
  let asked: Json | null = null;
  await submitRecording(store, recording.id, params({ inputPayload: { motesnamn: "KS" } }), {
    upload: async () => ({ id: "file-b" }),
    startRun: async (_flowId, body) => {
      asked = body;
      return queuedRun;
    },
  });
  assert.deepEqual(asked, {
    expected_flow_version: 3,
    step_inputs: { "step-audio": { file_ids: ["file-b"] } },
    input_payload_json: { motesnamn: "KS" },
  });
});

test("a run request whose answer never came is kept through a cancel and repeated exactly on the next send", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const store = await openRecordingStore({});
  const recording = await stoppedRecording(store, [["a"]]);
  const eneo = fakeEneo();
  let uploads = 0;
  const upload: SubmitDeps["upload"] = async () => ({ id: `file-${++uploads}` });
  const cancel = new AbortController();
  let waiting = false;
  const sending = submitRecording(
    store,
    recording.id,
    params({ inputPayload: { motesnamn: "KS" }, signal: cancel.signal, onWait: (wait) => (waiting = wait !== null) }),
    {
      upload,
      startRun: async (flowId, body, key) => {
        await eneo.startRun(flowId, body, key); // Eneo makes the run,
        throw fetchFailed(); // and its answer is lost
      },
    },
  );
  await until(() => waiting);
  cancel.abort(); // "Avbryt" while the send waits to ask again
  await assert.rejects(sending);
  const kept = await store.get(recording.id);
  assert.deepEqual([kept?.state, kept?.parts[0].fileId], ["uploaded", "file-1"], "the run may exist: not back to stopped");

  // After a reload the details start over; the send repeats the stored request and gets that run.
  const run = await submitRecording(store, recording.id, params({ inputPayload: {} }), { upload, startRun: eneo.startRun });
  assert.equal(run.id, "run-1");
  assert.equal(uploads, 1, "nothing uploaded again");
  assert.equal(eneo.runs.size, 1);
  assert.equal(await store.get(recording.id), null);
});

/** A send whose run Eneo made, but whose answer was lost and which was then cancelled: the request stays unresolved. */
async function unresolvedSend(t: TestContext, store: RecordingStore, eneo: ReturnType<typeof fakeEneo>, upload: SubmitDeps["upload"]) {
  const recording = await stoppedRecording(store, [["a"]]);
  const cancel = new AbortController();
  let waiting = false;
  const sending = submitRecording(
    store,
    recording.id,
    params({ signal: cancel.signal, onWait: (wait) => (waiting = wait !== null) }),
    {
      upload,
      startRun: async (flowId, body, key) => {
        await eneo.startRun(flowId, body, key);
        throw fetchFailed();
      },
    },
  );
  await until(() => waiting);
  cancel.abort();
  await assert.rejects(sending);
  t.mock.timers.reset();
  return recording;
}

test("an unresolved request stays through a 401 or 403 on its repeat, and after logging in the repeat gets the run", async (t) => {
  for (const refusal of [apiError(401), apiError(403, "insufficient_scope")]) {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const store = await openRecordingStore({});
    const eneo = fakeEneo();
    let uploads = 0;
    const upload: SubmitDeps["upload"] = async () => ({ id: `file-${++uploads}` });
    const recording = await unresolvedSend(t, store, eneo, upload);

    await assert.rejects(
      submitRecording(store, recording.id, params(), {
        upload,
        startRun: async () => {
          throw refusal; // the session ran out, or the key lacks the scope
        },
      }),
    );
    const kept = await store.get(recording.id);
    assert.deepEqual([kept?.state, kept?.parts[0].fileId, !!kept?.submission], ["uploaded", "file-1", true], String(refusal));

    const run = await submitRecording(store, recording.id, params(), { upload, startRun: eneo.startRun });
    assert.equal(run.id, "run-1", String(refusal));
    assert.equal(uploads, 1, "nothing uploaded again");
  }

  // The same within one send: the first attempt made the run unanswered, the next was refused.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const store = await openRecordingStore({});
  const eneo = fakeEneo();
  const recording = await stoppedRecording(store, [["a"]]);
  let attempts = 0;
  const sending = submitRecording(store, recording.id, params(), {
    upload: async () => ({ id: "file-1" }),
    startRun: async (flowId, body, key) => {
      attempts += 1;
      if (attempts > 1) throw apiError(401);
      await eneo.startRun(flowId, body, key);
      throw fetchFailed();
    },
  });
  await until(() => attempts === 1);
  await settle();
  t.mock.timers.tick(1_000);
  await assert.rejects(sending);
  assert.equal((await store.get(recording.id))?.state, "uploaded", "the run may exist");
  t.mock.timers.reset();
});

test("a request refused as stale is dropped for one from the refreshed form, under the same key and with the same uploads", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const store = await openRecordingStore({});
  const eneo = fakeEneo();
  let uploads = 0;
  const upload: SubmitDeps["upload"] = async () => ({ id: `file-${++uploads}` });
  const published = { version: 3 };
  const startRun: SubmitDeps["startRun"] = async (flowId, body, key) => {
    // Eneo refuses an old version before it looks at the key.
    if (body.expected_flow_version !== published.version) throw apiError(409, "flow_run_stale_version");
    return eneo.startRun(flowId, body, key);
  };
  const recording = await unresolvedSend(t, store, eneo, upload); // Eneo made the run; its answer was lost

  published.version = 4; // the flow is published again
  await assert.rejects(submitRecording(store, recording.id, params(), { upload, startRun }), {
    code: "flow_run_stale_version",
  });
  const kept = await store.get(recording.id);
  assert.deepEqual([kept?.state, kept?.submission ?? null, kept?.parts[0].fileId], ["uploading", null, "file-1"], "sealed, with its uploads");

  // Sent again from the refreshed form: the run Eneo made answers as a conflict.
  const current = { ...contract, published_flow_version: 4 };
  await assert.rejects(submitRecording(store, recording.id, params({ contract: current }), { upload, startRun }), {
    message: "Inspelningen har redan skickats. Körningen finns under Tidigare körningar.",
  });
  assert.equal(uploads, 1);
  assert.equal(eneo.runs.size, 1, "no second run");
  assert.equal((await store.get(recording.id))?.state, "uploaded", "still sealed");

  // Without a run behind it, the same key at the current version makes one.
  const other = await stoppedRecording(store, [["b"]]);
  published.version = 5;
  await assert.rejects(submitRecording(store, other.id, params({ contract: current }), { upload, startRun }), {
    code: "flow_run_stale_version",
  });
  const run = await submitRecording(store, other.id, params({ contract: { ...contract, published_flow_version: 5 } }), { upload, startRun });
  assert.equal(run.id, "run-2");
  assert.equal(uploads, 2, "one upload for each recording");
});

test("a recording being sent from one tab cannot be sent or deleted from another", async () => {
  const env = { indexedDB: new IDBFactory(), keyRange: IDBKeyRange, locks: fakeWebLocks() };
  const sendingTab = await openRecordingStore(env);
  const otherTab = await openRecordingStore(env);
  const recording = await stoppedRecording(sendingTab, [["a"]]);
  const upload: { finish?: () => void } = {};
  const sending = submitRecording(sendingTab, recording.id, params(), {
    upload: () =>
      new Promise((resolve) => {
        upload.finish = () => resolve({ id: "file-a" });
      }),
    startRun: async () => queuedRun,
  });
  await until(() => upload.finish !== undefined);

  const inUse = { message: "Inspelningen används i en annan flik." };
  await assert.rejects(
    submitRecording(otherTab, recording.id, params(), {
      upload: async () => ({ id: "file-b" }),
      startRun: async () => queuedRun,
    }),
    inUse,
  );
  await assert.rejects(otherTab.remove(recording.id), inUse);
  assert.deepEqual(await otherTab.listUnsent("user-1"), []);

  upload.finish?.();
  assert.equal((await sending).id, "run-1");
  assert.equal(await otherTab.get(recording.id), null);
});

/** Eneo's run creation as it treats idempotency keys: a replay returns the run, another request is refused. */
function fakeEneo() {
  const runs = new Map<string, { request: string; run: FlowRunPublic }>();
  const startRun: SubmitDeps["startRun"] = async (_flowId, body, key) => {
    const request = JSON.stringify(body);
    const existing = runs.get(key);
    if (existing) {
      if (existing.request !== request) {
        throw new ApiError(400, "Idempotency key was already used with a different run request payload.", null, "flow_run_idempotency_conflict");
      }
      return existing.run;
    }
    const run = { id: `run-${runs.size + 1}`, flow_id: "flow-1", status: "queued" };
    runs.set(key, { request, run });
    return run;
  };
  return { runs, startRun };
}

test("a send that died after Eneo made the run gets that run back, not a second one", async () => {
  const device = { indexedDB: new IDBFactory(), keyRange: IDBKeyRange, locks: fakeWebLocks() };
  const tabThatDies = await openRecordingStore(device);
  const recording = await stoppedRecording(tabThatDies, [["a"]]);
  const eneo = fakeEneo();
  const lostResponse: SubmitDeps = {
    upload: async () => ({ id: "file-a" }),
    startRun: async (flowId, body, key) => {
      await eneo.startRun(flowId, body, key);
      return new Promise<FlowRunPublic>(() => {}); // the tab dies before the answer arrives
    },
  };
  void submitRecording(tabThatDies, recording.id, params(), lostResponse);
  await until(() => eneo.runs.size === 1);
  tabThatDies.release(recording.id); // the browser ends a dead tab's lock

  const afterReload = await openRecordingStore(device);
  const run = await submitRecording(afterReload, recording.id, params(), {
    upload: async () => ({ id: "file-b" }),
    startRun: eneo.startRun,
  });
  assert.equal(run.id, "run-1");
  assert.equal(eneo.runs.size, 1);
  assert.equal(await afterReload.get(recording.id), null);
});

test("the run body carries speaker_labels only when the page passes the choice", async () => {
  const bodies: Json[] = [];
  const deps: SubmitDeps = {
    upload: async () => ({ id: "file-1" }),
    startRun: async (_flowId, body) => {
      bodies.push(body);
      return queuedRun;
    },
  };
  await submitRun(params({ speakerLabels: false }), deps);
  await submitRun(params(), deps);
  assert.equal(bodies[0].speaker_labels, false);
  assert.equal("speaker_labels" in bodies[1], false);
});

test("a new run with the failed run's audio and details has a key of its own, apart from Eneo's retry", async () => {
  const failed: FlowRunPublic = {
    id: "run-1",
    flow_id: "flow-1",
    status: "failed",
    input_payload_json: { deltagare: "Anna Berg, Erik Lund" },
  };
  const steps: FlowRunStep[] = [
    { id: "result-2", step_id: "step-summary", step_order: 2, status: "failed" },
    { id: "result-1", step_id: "step-audio", step_order: 1, status: "completed", runtime_input_file_ids: ["file-a", "file-b"] },
  ];

  const request = startAgainRequest(failed, steps, contract);
  assert.ok(request && "body" in request);

  assert.deepEqual(request.body, {
    expected_flow_version: 3,
    step_inputs: { "step-audio": { file_ids: ["file-a", "file-b"] } },
    input_payload_json: { deltagare: "Anna Berg, Erik Lund" },
  });
  // The failed run was keyed on this same body, so its key would replay it; Eneo's retry has its own.
  const replay = await deriveRunIdempotencyKey({ flowId: "flow-1", expectedFlowVersion: 3, body: request!.body });
  assert.equal(request!.idempotencyKey, "flow-run-again:run-1");
  assert.notEqual(request!.idempotencyKey, replay);
  // Without the recording there is nothing to start again with.
  assert.equal(startAgainRequest(failed, [steps[0]], contract), null);
});

test("Starta en ny körning is asked against the flow as published now, and a changed input asks for a new one instead", async () => {
  const failed: FlowRunPublic = { id: "run-1", flow_id: "flow-1", status: "failed", input_payload_json: { motesnamn: "KS" } };
  const steps: FlowRunStep[] = [
    { id: "result-1", step_id: "step-audio", step_order: 1, status: "completed", runtime_input_file_ids: ["file-a", "file-b"] },
  ];
  const republished: RunContract = { ...contract, published_flow_version: 4 };
  const bodies: Json[] = [];
  const outcome = await startAgain("flow-1", failed, steps, { online: createOnlineStatus() }, {
    getContract: async () => republished,
    startRun: async (_flowId, body) => {
      bodies.push(body);
      return queuedRun;
    },
  });
  assert.equal(outcome?.kind, "started");
  assert.equal(outcome?.contract, republished, "the page shows the flow as it is now");
  assert.deepEqual(bodies, [
    {
      expected_flow_version: 4,
      step_inputs: { "step-audio": { file_ids: ["file-a", "file-b"] } },
      input_payload_json: { motesnamn: "KS" },
    },
  ]);

  const step = contract.steps_requiring_input![0];
  const changed: Array<[string, RunContract]> = [
    ["another input step", { ...republished, steps_requiring_input: [{ ...step, step_id: "step-upload" }] }],
    ["fewer files", { ...republished, steps_requiring_input: [{ ...step, max_files: 1 }] }],
    ["a new required detail", { ...republished, form_fields: [{ name: "datum", label: "Datum", type: "text", required: true }] }],
  ];
  for (const [what, current] of changed) {
    let posts = 0;
    const review = await startAgain("flow-1", failed, steps, { online: createOnlineStatus() }, {
      getContract: async () => current,
      startRun: async () => {
        posts += 1;
        return queuedRun;
      },
    });
    assert.equal(review?.kind, "review", what);
    assert.match(review?.kind === "review" ? review.message : "", /Flödet har ändrats sedan körningen/, what);
    assert.equal(posts, 0, `${what}: nothing is sent`);
  }
});

test("details a run left empty, as Eneo keeps them, count as missing once the flow requires them", async () => {
  const steps: FlowRunStep[] = [
    { id: "result-1", step_id: "step-audio", step_order: 1, status: "completed", runtime_input_file_ids: ["file-a"] },
  ];
  const required = (name: string, type: string): RunContract => ({
    ...contract,
    published_flow_version: 4,
    form_fields: [{ name, label: name, type, required: true }],
  });
  const cases: Array<[string, Json, RunContract, "review" | "started"]> = [
    ["blank text", { datum: "" }, required("datum", "text"), "review"],
    ["whitespace", { datum: "  " }, required("datum", "text"), "review"],
    ["an empty list", { deltagare: [] }, required("deltagare", "list"), "review"],
    ["zero", { antal: 0 }, required("antal", "number"), "started"],
    ["a name", { deltagare: ["Anna Berg"] }, required("deltagare", "list"), "started"],
  ];
  for (const [what, payload, current, expected] of cases) {
    let posts = 0;
    const failed: FlowRunPublic = { id: "run-1", flow_id: "flow-1", status: "failed", input_payload_json: payload };
    const outcome = await startAgain("flow-1", failed, steps, { online: createOnlineStatus() }, {
      getContract: async () => current,
      startRun: async () => {
        posts += 1;
        return queuedRun;
      },
    });
    assert.equal(outcome?.kind, expected, what);
    assert.equal(posts, expected === "started" ? 1 : 0, what);
  }
});

test("Starta en ny körning sends nothing more once the page is gone, and gives no run to follow", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const failed: FlowRunPublic = { id: "run-1", flow_id: "flow-1", status: "cancelled", input_payload_json: null };
  const steps: FlowRunStep[] = [
    { id: "result-1", step_id: "step-audio", step_order: 1, status: "completed", runtime_input_file_ids: ["file-a"] },
  ];
  // Left during the wait before asking again.
  const leftWaiting = new AbortController();
  let posts = 0;
  let waiting = false;
  const outcome = startAgain("flow-1", failed, steps, {
    online: createOnlineStatus(),
    signal: leftWaiting.signal,
    onWait: (wait) => (waiting = wait !== null),
  }, {
    getContract: async () => contract,
    startRun: async () => {
      posts += 1;
      throw fetchFailed();
    },
  });
  await until(() => waiting);
  leftWaiting.abort();
  assert.equal(await outcome, null);
  t.mock.timers.tick(120_000);
  await settle();
  assert.equal(posts, 1, "no request after the page is gone");

  // Left just as Eneo answered: the run exists, but this page follows nothing.
  const leftAnswering = new AbortController();
  const answered = await startAgain("flow-1", failed, steps, { online: createOnlineStatus(), signal: leftAnswering.signal }, {
    getContract: async () => contract,
    startRun: async () => {
      leftAnswering.abort();
      return queuedRun;
    },
  });
  assert.equal(answered, null);

  const kept = await startAgain("flow-1", failed, steps, { online: createOnlineStatus(), signal: new AbortController().signal }, {
    getContract: async () => contract,
    startRun: async () => queuedRun,
  });
  assert.equal(kept?.kind === "started" && kept.run.id, "run-1");
});

test("Försök igen asks Eneo to continue the failed run under a key that names it, and returns the child run", async () => {
  const calls: [string, string, string][] = [];
  const child: FlowRunPublic = { id: "run-2", flow_id: "flow-1", status: "queued" };
  const outcome = await retryFailedRun("flow-1", "run-1", async (flowId, runId, key) => {
    calls.push([flowId, runId, key]);
    return { run: child, created: true, source_run_id: runId, first_executed_step_order: 2, reused_step_orders: [1] };
  });

  assert.deepEqual(calls, [["flow-1", "run-1", "flow-run-retry:run-1"]]);
  // The page follows the child, not the failed source.
  assert.deepEqual(outcome, { kind: "started", run: child });
});

test("each refusal from Eneo's retry says why, and whether a new run with the same audio is the way on", async () => {
  const refused = async (error: unknown) =>
    retryFailedRun("flow-1", "run-1", async () => {
      throw error;
    });
  const cases: [ApiError | TypeError, RegExp, boolean][] = [
    [apiError(409, "flow_run_retry_source_version_stale"), /Flödet har ändrats sedan körningen/, true],
    [apiError(409, "flow_run_retry_nothing_to_reuse"), /Inget steg hann bli klart/, true],
    [apiError(409, "flow_run_retry_prefix_unsupported"), /kan inte återanvändas/, true],
    [apiError(409, "flow_run_retry_source_not_failed"), /Bara en misslyckad körning/, true],
    [apiError(403, "flow_run_access_denied"), /Bara den som startade körningen/, false],
    [apiError(429, "flow_run_concurrency_limit_reached"), /För många körningar pågår just nu/, false],
    [apiError(404, "not_found"), /Körningen finns inte längre/, false],
    // Refusals not known to be about Eneo's retry itself offer no new run with the same input.
    [apiError(400, "flow_run_invalid_idempotency_key"), /kunde inte fortsätta där den stannade/, false],
    [apiError(413, "flow_run_step_input_file_too_large"), /kunde inte fortsätta där den stannade/, false],
    [apiError(401), /kunde inte fortsätta där den stannade/, false],
    [apiError(403, "insufficient_scope"), /kunde inte fortsätta där den stannade/, false],
    [fetchFailed(), /Anslutningen avbröts/, false],
    [apiError(503, "flow_evidence_audit_logging_failed"), /Servern kunde inte nås just nu/, false],
  ];
  for (const [error, sentence, startAgain] of cases) {
    const outcome = await refused(error);
    assert.equal(outcome.kind, "refused");
    if (outcome.kind !== "refused") continue;
    assert.match(outcome.message, sentence, String(error));
    assert.equal(outcome.startAgain, startAgain, String(error));
    // Never Eneo's English message or a raw code as the sentence.
    assert.doesNotMatch(outcome.message, /HTTP|flow_run_|not_found/);
  }
});

test("the retry goes to Eneo's retry path as a POST carrying the key", async (t) => {
  const seen: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    const body = { run: { id: "run-2", flow_id: "flow-1", status: "queued" }, created: true, source_run_id: "run-1", first_executed_step_order: 2, reused_step_orders: [1] };
    return new Response(JSON.stringify(body), { status: 201, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const outcome = await retryFailedRun("flow-1", "run-1");

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/api/eneo/flows/flow-1/runs/run-1/retry/");
  assert.equal(seen[0].init.method, "POST");
  assert.equal((seen[0].init.headers as Record<string, string>)["Idempotency-Key"], "flow-run-retry:run-1");
  assert.equal(outcome.kind === "started" && outcome.run.id, "run-2");
});
