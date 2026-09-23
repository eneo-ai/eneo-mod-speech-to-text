import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, deriveRunIdempotencyKey, type FlowRunPublic, type FlowRunStep, type Json, type RunContract } from "./api";
import { createOnlineStatus, type OnlineTarget } from "./online-status";
import { openRecordingStore, type NewRecording, type RecordingStore } from "./recording-store";
import {
  retryFailedRun,
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
  flowId: "flow-1",
  flowName: "Nämndmöte till rapport",
  stepId: "step-audio",
  inputMode: "record",
  mimeType: "audio/webm;codecs=opus",
};

async function stoppedRecording(store: RecordingStore, parts: string[][]) {
  const recording = await store.create(meeting);
  for (const chunks of parts) {
    const index = await store.startPart(recording.id);
    for (const chunk of chunks) await store.append(recording.id, index, new Blob([chunk]), 1_000);
  }
  await store.setState(recording.id, "stopped");
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
  assert.deepEqual(await store.listUnsent(), []);

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
  assert.equal((await store.listUnsent()).length, 1);

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
  assert.equal((await store.listUnsent()).length, 1);
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

  const request = startAgainRequest(failed, steps, contract, "step-audio");

  assert.deepEqual(request?.body, {
    expected_flow_version: 3,
    step_inputs: { "step-audio": { file_ids: ["file-a", "file-b"] } },
    input_payload_json: { deltagare: "Anna Berg, Erik Lund" },
  });
  // The failed run was keyed on this same body, so its key would replay it; Eneo's retry has its own.
  const replay = await deriveRunIdempotencyKey({ flowId: "flow-1", expectedFlowVersion: 3, body: request!.body });
  assert.equal(request!.idempotencyKey, "flow-run-again:run-1");
  assert.notEqual(request!.idempotencyKey, replay);
  // Without the recording there is nothing to start again with.
  assert.equal(startAgainRequest(failed, [steps[0]], contract, "step-audio"), null);
  assert.equal(startAgainRequest(failed, steps, contract, null), null);
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
    [apiError(400, "flow_run_invalid_idempotency_key"), /kunde inte fortsätta där den stannade/, true],
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
