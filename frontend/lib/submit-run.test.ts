import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import { ApiError, deriveRunIdempotencyKey, type FlowRunPublic, type Json, type RunContract } from "./api";
import { fakeWebLocks } from "./fake-web-locks";
import { createOnlineStatus, type OnlineTarget } from "./online-status";
import { openRecordingStore, type NewRecording, type RecordingStore } from "./recording-store";
import {
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
  assert.equal(calls, 1, "a cancelled send is not retried");
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
    { message: "Filen är för stor (2.0 kB). Max: 1.0 kB." },
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
  assert.deepEqual([kept?.state, kept?.parts.map((p) => p.fileId)], ["stopped", ["file-a", null]]);
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
  assert.deepEqual([kept?.state, kept?.parts[0].fileId], ["stopped", null]);
  assert.equal((await store.listUnsent("user-1")).length, 1);
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

test("two tabs sending one recording make one run, even without Web Locks", async () => {
  for (const tabBReads of ["after tab A uploaded", "before tab A uploaded"] as const) {
    const device = { indexedDB: new IDBFactory(), keyRange: IDBKeyRange }; // no Web Locks
    const tabA = await openRecordingStore(device);
    const tabB = await openRecordingStore(device);
    const recording = await stoppedRecording(tabA, [["a"]]);
    const eneo = fakeEneo();

    // Tab B may have read the recording before tab A's upload was stored.
    const tabBUpload: { started?: boolean; finish?: () => void } = {};
    const tabBSend = () =>
      submitRecording(tabB, recording.id, params(), {
        upload: () =>
          new Promise((resolve) => {
            tabBUpload.started = true;
            tabBUpload.finish = () => resolve({ id: "file-b" });
          }),
        startRun: eneo.startRun,
      });
    const early = tabBReads === "before tab A uploaded" ? tabBSend() : null;
    if (early) await until(() => tabBUpload.started === true);

    // Eneo makes tab A's run; its answer is still on the way when tab B asks.
    const tabAAnswer: { made?: boolean; deliver?: () => void } = {};
    const tabASend = submitRecording(tabA, recording.id, params(), {
      upload: async () => ({ id: "file-a" }),
      startRun: async (flowId, body, key) => {
        const run = await eneo.startRun(flowId, body, key);
        tabAAnswer.made = true;
        return new Promise((resolve) => (tabAAnswer.deliver = () => resolve(run)));
      },
    });
    await until(() => tabAAnswer.made === true);
    const late = early ?? tabBSend();
    if (early) tabBUpload.finish?.();

    if (early) {
      // Its own upload makes another request under the recording's key: Eneo refuses it.
      await assert.rejects(late, { message: "Inspelningen har redan skickats, till exempel från en annan flik." });
    } else {
      // It sends tab A's upload again: Eneo answers with the same run.
      assert.equal((await late).id, "run-1", tabBReads);
    }
    tabAAnswer.deliver?.();
    assert.equal((await tabASend).id, "run-1", tabBReads);
    assert.equal(eneo.runs.size, 1, tabBReads);
    assert.equal(await tabB.get(recording.id), null, `${tabBReads}: no copy comes back`);
  }
});

test("a tab refused by Eneo is told the recording was sent, even when the other tab has deleted its copy", async () => {
  const device = { indexedDB: new IDBFactory(), keyRange: IDBKeyRange }; // no Web Locks
  const tabA = await openRecordingStore(device);
  const tabB = await openRecordingStore(device);
  const recording = await stoppedRecording(tabA, [["a"]]);
  const eneo = fakeEneo();

  const tabBUpload: { started?: boolean; finish?: () => void } = {};
  const tabBAnswer: { made?: boolean; deliver?: () => void } = {};
  const tabBSend = submitRecording(tabB, recording.id, params(), {
    upload: () =>
      new Promise((resolve) => {
        tabBUpload.started = true;
        tabBUpload.finish = () => resolve({ id: "file-b" });
      }),
    startRun: async (flowId, body, key) => {
      const answer = eneo.startRun(flowId, body, key).then(
        (run) => () => run,
        (error) => () => {
          throw error;
        },
      );
      tabBAnswer.made = true;
      await new Promise<void>((resolve) => (tabBAnswer.deliver = resolve));
      return (await answer)();
    },
  });
  await until(() => tabBUpload.started === true);
  const tabAAnswer: { made?: boolean; deliver?: () => void } = {};
  const tabASend = submitRecording(tabA, recording.id, params(), {
    upload: async () => ({ id: "file-a" }),
    startRun: async (flowId, body, key) => {
      const run = await eneo.startRun(flowId, body, key);
      tabAAnswer.made = true;
      return new Promise((resolve) => (tabAAnswer.deliver = () => resolve(run)));
    },
  });
  await until(() => tabAAnswer.made === true);
  tabBUpload.finish?.();
  await until(() => tabBAnswer.made === true); // Eneo has refused tab B; the answer is on its way
  tabAAnswer.deliver?.();
  assert.equal((await tabASend).id, "run-1");
  assert.equal(await tabA.get(recording.id), null, "tab A's copy is deleted");

  tabBAnswer.deliver?.();
  await assert.rejects(tabBSend, { message: "Inspelningen har redan skickats, till exempel från en annan flik." });
  assert.equal(eneo.runs.size, 1);
});

test("a send that died after Eneo made the run gets that run back, not a second one", async () => {
  const device = { indexedDB: new IDBFactory(), keyRange: IDBKeyRange };
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

  const afterReload = await openRecordingStore(device);
  const run = await submitRecording(afterReload, recording.id, params(), {
    upload: async () => ({ id: "file-b" }),
    startRun: eneo.startRun,
  });
  assert.equal(run.id, "run-1");
  assert.equal(eneo.runs.size, 1);
  assert.equal(await afterReload.get(recording.id), null);
});
