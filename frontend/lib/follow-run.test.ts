import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, type FlowGraph, type FlowRunSummary } from "./api";
import { CORRECTIONS_WAIT_MS, HIDDEN_POLL_MS, VISIBLE_POLL_MS, followDelivery, followRun, readFinishedRun, type PageVisibility, type RunSnapshot } from "./follow-run";
import { createOnlineStatus } from "./online-status";

const settle = () => new Promise((resolve) => setImmediate(resolve));
async function until(condition: () => boolean) {
  for (let i = 0; i < 1_000 && !condition(); i += 1) await settle();
  assert.ok(condition(), "never happened");
}

const run = (status: string): FlowRunSummary => ({ id: "run-1", flow_id: "flow-1", status });
const graph = (status: string | null): FlowGraph => ({
  nodes: [{ id: "s1", label: "Transkribera", type: "llm", step_order: 1, input_source: null, input_type: "audio", output_type: null, output_mode: null, run_status: status }],
  edges: [],
});

function fakePage(hidden: boolean) {
  const listeners = new Set<() => void>();
  const page: PageVisibility & { hidden: boolean; show(): void; watching(): number } = {
    hidden,
    watching: () => listeners.size,
    onVisible(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    show() {
      page.hidden = false;
      [...listeners].forEach((listener) => listener());
    },
  };
  return page;
}

function eneo(statuses: string[]) {
  const calls = { status: 0, graph: 0 };
  return {
    calls,
    deps: {
      getStatus: async () => run(statuses[Math.min(calls.status++, statuses.length - 1)]),
      getGraph: async () => {
        calls.graph += 1;
        return graph(calls.graph === 1 ? "pending" : "running");
      },
    },
  };
}

test("follows the status and the run-pinned graph until the run ends, then stops", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, deps } = eneo(["queued", "running", "completed"]);
  const snapshots: RunSnapshot[] = [];

  const last = followRun("flow-1", "run-1", {
    signal: new AbortController().signal,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    page: fakePage(false),
    online: createOnlineStatus(),
    deps,
  });

  await until(() => snapshots.length === 1);
  assert.equal(snapshots[0].graph?.nodes[0].run_status, "pending");
  t.mock.timers.tick(VISIBLE_POLL_MS - 1);
  await settle();
  assert.equal(calls.status, 1, "no poll before the interval");
  t.mock.timers.tick(1);
  await until(() => snapshots.length === 2);
  t.mock.timers.tick(VISIBLE_POLL_MS);
  const result = await last;

  assert.equal(result?.run.status, "completed");
  assert.deepEqual(snapshots.map((s) => s.run.status), ["queued", "running", "completed"]);
  t.mock.timers.tick(10 * VISIBLE_POLL_MS);
  await settle();
  assert.deepEqual(calls, { status: 3, graph: 3 }, "nothing is read after the run ended");
});

test("the step results are read once while the run goes, when the graph first says a step's live text is not used", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const statuses = ["running", "running", "running", "completed"];
  const reasons = [null, "not_received", "not_received", "not_received"] as const;
  const calls = { status: 0, steps: 0 };
  const read = [{ id: "result-1", step_id: "s1", status: "running", live_fallback_reason: "not_received" as const, transcript_model_name: "KB Whisper" }];
  const snapshots: RunSnapshot[] = [];
  const done = followRun("flow-1", "run-1", {
    signal: new AbortController().signal,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    page: fakePage(false),
    online: createOnlineStatus(),
    deps: {
      getStatus: async () => run(statuses[calls.status++]),
      getGraph: async () => {
        const plain = graph("running");
        return { ...plain, nodes: [{ ...plain.nodes[0], live_fallback_reason: reasons[calls.status - 1] }] };
      },
      getSteps: async () => {
        calls.steps += 1;
        return read;
      },
    },
  });
  for (let poll = 1; poll < statuses.length; poll += 1) {
    await until(() => snapshots.length === poll);
    t.mock.timers.tick(VISIBLE_POLL_MS);
  }
  await done;

  assert.deepEqual(snapshots.map((snapshot) => snapshot.steps), [[], read, read, read], "from the poll that saw the reason on");
  assert.equal(calls.steps, 1, "read once");

  // A run whose live text is used, or that streamed nothing, never reads them while it goes.
  const { deps } = eneo(["running", "completed"]);
  let plainReads = 0;
  let polls = 0;
  const plainDone = followRun("flow-1", "run-1", {
    signal: new AbortController().signal,
    onSnapshot: () => (polls += 1),
    page: fakePage(false),
    online: createOnlineStatus(),
    deps: { ...deps, getSteps: async () => ((plainReads += 1), []) },
  });
  await until(() => polls === 1);
  t.mock.timers.tick(VISIBLE_POLL_MS);
  assert.equal((await plainDone)?.run.status, "completed");
  assert.equal(plainReads, 0);
});

test("a run that waits for review ends the follow so the review can open", async () => {
  const { deps } = eneo(["awaiting_review"]);
  const result = await followRun("flow-1", "run-1", {
    signal: new AbortController().signal,
    onSnapshot: () => undefined,
    page: fakePage(false),
    online: createOnlineStatus(),
    deps,
  });
  assert.equal(result?.run.status, "awaiting_review");
});

test("a hidden page polls rarely and catches up as soon as it is shown again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const page = fakePage(true);
  const { calls, deps } = eneo(["running"]);
  const controller = new AbortController();
  const done = followRun("flow-1", "run-1", {
    signal: controller.signal,
    onSnapshot: () => undefined,
    page,
    online: createOnlineStatus(),
    deps,
  });

  // The pause has begun once it watches for the page to be shown.
  await until(() => calls.status === 1 && page.watching() === 1);
  t.mock.timers.tick(VISIBLE_POLL_MS * 5);
  await settle();
  assert.equal(calls.status, 1, "hidden: no poll at the visible pace");
  t.mock.timers.tick(HIDDEN_POLL_MS - VISIBLE_POLL_MS * 5);
  await until(() => calls.status === 2 && page.watching() === 1);

  page.show();
  await until(() => calls.status === 3);

  controller.abort();
  assert.equal(await done, null);
});

test("a failed graph read keeps the last graph; the status still moves on", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let graphReads = 0;
  const statuses = ["running", "failed"];
  const snapshots: RunSnapshot[] = [];
  const done = followRun("flow-1", "run-1", {
    signal: new AbortController().signal,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    page: fakePage(false),
    online: createOnlineStatus(),
    deps: {
      getStatus: async () => run(statuses[Math.min(snapshots.length, 1)]),
      getGraph: async () => {
        graphReads += 1;
        if (graphReads > 1) throw new Error("graph unavailable");
        return graph("running");
      },
    },
  });

  await until(() => snapshots.length === 1);
  t.mock.timers.tick(VISIBLE_POLL_MS);
  const last = await done;
  assert.equal(last?.run.status, "failed");
  assert.equal(last?.graph?.nodes[0].run_status, "running");
});

const DETAIL = "/api/eneo/flows/flow-1/runs/run-1/";
const STEPS = "/api/eneo/flows/flow-1/runs/run-1/steps/";
const CORRECTIONS = "/api/eneo/flows/flow-1/runs/run-1/transcript-corrections/";

/** Eneo answering the end-of-run reads, with exactly `failing` (one endpoint) answering 500. */
function endOfRunReads(t: { after: (fn: () => void) => void }, failing: string | null) {
  const original = globalThis.fetch;
  const answered: [string, number][] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = new URL(String(url), "http://module.test").pathname;
    if (path === failing) {
      answered.push([path, 500]);
      return new Response(JSON.stringify({ detail: "fel" }), { status: 500 });
    }
    answered.push([path, 200]);
    const body = path === STEPS ? [] : { id: "run-1", flow_id: "flow-1", status: "completed", result: { kind: "inline_text", text: "Klart" } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return answered;
}

test("a finished run reads its detail and its step results", async (t) => {
  endOfRunReads(t, null);
  const read = await readFinishedRun("flow-1", run("completed"));
  assert.equal(read.run.result?.kind, "inline_text");
  assert.deepEqual(read.steps, []);
});

test("a finished run whose detail cannot be read fails, never shows 'klart' without the document", async (t) => {
  const answered = endOfRunReads(t, DETAIL);
  await assert.rejects(readFinishedRun("flow-1", run("completed")));
  assert.deepEqual(new Map(answered), new Map([[DETAIL, 500], [STEPS, 200], [CORRECTIONS, 200]]), "only the detail failed");
});

test("a finished run whose step results cannot be read fails, never hides the transcript and steps", async (t) => {
  const answered = endOfRunReads(t, STEPS);
  await assert.rejects(readFinishedRun("flow-1", run("completed")));
  assert.deepEqual(new Map(answered), new Map([[DETAIL, 200], [STEPS, 500], [CORRECTIONS, 200]]), "only the steps failed");
});

test("a finished run without a transcript is drawn as soon as it is read, without waiting for saved corrections", async (t) => {
  endOfRunReads(t, null);
  const read = await readFinishedRun("flow-1", run("completed"));
  assert.equal(read.run.result?.kind, "inline_text");
  assert.equal(read.corrections, undefined, "not waited for");
});

test("a result with a transcript waits for its saved corrections, and a read that fails is said as failed", async (t) => {
  const original = globalThis.fetch;
  t.after(() => void (globalThis.fetch = original));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const transcribed = [{ id: "r1", step_id: "s1", step_order: 1, status: "completed", input_payload_json: { transcription: { text: "Hej." } } }];
  const answer = (corrections: () => Response) =>
    (globalThis.fetch = (async (url: string | URL | Request) => {
      const path = new URL(String(url), "http://module.test").pathname;
      if (path === STEPS) return json(transcribed);
      if (path === CORRECTIONS) return corrections();
      return json({ id: "run-1", flow_id: "flow-1", status: "completed", result: { kind: "inline_text", text: "Klart" } });
    }) as typeof fetch);
  answer(() => json([{ step_id: "s1", revision: 3 }]));
  assert.deepEqual((await readFinishedRun("flow-1", run("completed"))).corrections, [{ step_id: "s1", revision: 3 }]);
  answer(() => json({ detail: "fel" }, 404));
  assert.equal((await readFinishedRun("flow-1", run("completed"))).corrections, null, "failed: the transcript says so, it does not read again");
});

test("saved corrections that do not answer in time leave the result to be drawn, and hand the same read to the transcript", async (t) => {
  const original = globalThis.fetch;
  t.after(() => void (globalThis.fetch = original));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const transcribed = [{ id: "r1", step_id: "s1", step_order: 1, status: "completed", input_payload_json: { transcription: { text: "Hej." } } }];
  let corrections = 0;
  let answer = () => undefined as void;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = new URL(String(url), "http://module.test").pathname;
    if (path === CORRECTIONS) {
      corrections += 1;
      return new Promise<Response>((resolve) => (answer = () => resolve(json([{ step_id: "s1", revision: 3 }]))));
    }
    return json(path === STEPS ? transcribed : { id: "run-1", flow_id: "flow-1", status: "completed", result: { kind: "inline_text", text: "Klart" } });
  }) as typeof fetch;
  let read: Awaited<ReturnType<typeof readFinishedRun>> | null = null;
  void readFinishedRun("flow-1", run("completed")).then((answer) => (read = answer));
  // The wait starts once the run and its steps are read; each turn lets the time pass.
  await until(() => {
    t.mock.timers.tick(CORRECTIONS_WAIT_MS);
    return read !== null;
  });
  const late = read!.corrections;
  assert.ok(late && !Array.isArray(late) && "reading" in late, "drawn without them, the read still under way");
  answer();
  assert.deepEqual(await late.reading, [{ step_id: "s1", revision: 3 }], "and the transcript gets that same read");
  assert.equal(corrections, 1, "asked once");
});

test("reads that keep failing stop being retried once the page tears the follow down", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const teardown = new AbortController();
  let reads = 0;
  const following = followRun("flow-1", "run-1", {
    signal: teardown.signal,
    onSnapshot: () => undefined,
    page: fakePage(false),
    online: createOnlineStatus(),
    deps: {
      getStatus: async () => {
        reads += 1;
        throw new TypeError("Failed to fetch");
      },
      getGraph: async () => graph(null),
    },
  });
  await until(() => reads === 1);
  teardown.abort();
  await following.catch(() => undefined);
  t.mock.timers.tick(120_000);
  await settle();
  assert.equal(reads, 1, "no read after the teardown");
});

const sending = (state: string | null, next_delivery_at: string | null = null): FlowRunSummary => ({
  ...run("completed"),
  result_delivery: state === null ? null : { state: state as never, next_delivery_at },
});

/** Eneo's status for a finished run whose sending goes through `states`, the last one for ever; what each read was asked. */
function deliveryReads(states: (string | null | Error)[]) {
  const reads: { at: number; signal: AbortSignal | undefined }[] = [];
  return {
    reads,
    deps: {
      getStatus: async (_flowId: string, _runId: string, signal?: AbortSignal) => {
        reads.push({ at: Date.now(), signal });
        const next = states[Math.min(reads.length - 1, states.length - 1)];
        if (next instanceof Error) throw next;
        return sending(next);
      },
    },
  };
}

/** Lets the fake clock run `ms`, a second at a time, so each read and pause in between happens when it is due. */
async function pass(t: { mock: { timers: { tick(ms: number): void } } }, ms: number) {
  for (let left = ms; left > 0; left -= 1_000) {
    t.mock.timers.tick(Math.min(1_000, left));
    for (let i = 0; i < 20; i += 1) await settle();
  }
}

test("a finished run whose result is on its way is followed by its status alone until the result is delivered", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { reads, deps } = deliveryReads(["sending", "sending", "delivered"]);
  const heard: (string | null | undefined)[] = [];
  const controller = new AbortController();
  const done = followDelivery("flow-1", "run-1", sending("sending"), {
    signal: controller.signal,
    onStatus: (status) => heard.push(status.result_delivery?.state),
    page: fakePage(false),
    online: createOnlineStatus(),
    deps,
  });

  await settle();
  assert.equal(reads.length, 0, "the first status is the one the run finished with: nothing is read at once");
  await pass(t, 6_000);
  await done;
  assert.deepEqual(reads.map((read) => read.at), [2_000, 4_000, 6_000]);
  assert.deepEqual(heard, ["delivered"], "only a change is told");
  assert.ok(reads.every((read) => read.signal === controller.signal), "each read can be called off");
  await pass(t, 60_000);
  assert.equal(reads.length, 3, "nothing is read once it is delivered");
});

test("the status is read every 2 s for half a minute, every 5 s up to two minutes, then every 15 s, while the state stays the same", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { reads, deps } = deliveryReads(["sending"]);
  const controller = new AbortController();
  const done = followDelivery("flow-1", "run-1", sending("sending"), {
    signal: controller.signal,
    onStatus: () => undefined,
    page: fakePage(false),
    online: createOnlineStatus(),
    deps,
  });
  await pass(t, 150_000);
  controller.abort();
  await done;
  const every = (from: number, to: number, step: number) => Array.from({ length: (to - from) / step + 1 }, (_, i) => from + i * step);
  assert.deepEqual(reads.map((read) => read.at), [...every(2_000, 30_000, 2_000), ...every(35_000, 120_000, 5_000), 135_000, 150_000]);
});

test("a new state starts the pace again from 2 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  // Sending for a minute (reads at 2..30 s every 2 s, then 35..60 s every 5 s: 21 reads), then a retry is planned.
  const { reads, deps } = deliveryReads([...Array<string>(20).fill("sending"), "retry_scheduled"]);
  const controller = new AbortController();
  const done = followDelivery("flow-1", "run-1", sending("sending"), {
    signal: controller.signal,
    onStatus: () => undefined,
    page: fakePage(false),
    online: createOnlineStatus(),
    deps,
  });
  await pass(t, 63_000);
  controller.abort();
  await done;
  assert.deepEqual(reads.slice(-3).map((read) => read.at), [55_000, 60_000, 62_000], "2 s after the change");
});

test("a retry time that has passed is no reason to read at once: the next read is still a pace away", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10 * 60_000 });
  const passed = new Date(0).toISOString();
  const { reads, deps } = deliveryReads(["retry_scheduled"]);
  const controller = new AbortController();
  const done = followDelivery("flow-1", "run-1", { ...run("completed"), result_delivery: { state: "retry_scheduled", next_delivery_at: passed } }, {
    signal: controller.signal,
    onStatus: () => undefined,
    page: fakePage(false),
    online: createOnlineStatus(),
    deps: { getStatus: async (flowId: string, runId: string, signal?: AbortSignal) => ({ ...(await deps.getStatus(flowId, runId, signal)), result_delivery: { state: "retry_scheduled", next_delivery_at: passed } }) },
  });
  await pass(t, 1_000);
  assert.equal(reads.length, 0);
  await pass(t, 3_000);
  assert.equal(reads.length, 2, "one read per 2 s, not a loop");
  controller.abort();
  await done;
});

test("a hidden page reads the sending rarely and catches up as soon as it is shown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const page = fakePage(true);
  const { reads, deps } = deliveryReads(["sending"]);
  const controller = new AbortController();
  const done = followDelivery("flow-1", "run-1", sending("sending"), { signal: controller.signal, onStatus: () => undefined, page, online: createOnlineStatus(), deps });
  await pass(t, HIDDEN_POLL_MS - 1_000);
  assert.equal(reads.length, 0, "hidden: not at the visible pace");
  await pass(t, 1_000);
  assert.equal(reads.length, 1);
  page.show();
  await until(() => reads.length === 2);
  controller.abort();
  await done;
});

test("a state that is no longer under way, or one the module does not know, ends the following", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  for (const end of ["dead_lettered", "unknown", null]) {
    const { reads, deps } = deliveryReads(["retry_scheduled", end]);
    const heard: unknown[] = [];
    const done = followDelivery("flow-1", "run-1", sending("sending"), {
      signal: new AbortController().signal,
      onStatus: (status) => heard.push(status.result_delivery?.state ?? null),
      page: fakePage(false),
      online: createOnlineStatus(),
      deps,
    });
    await pass(t, 4_000);
    await done;
    await pass(t, 60_000);
    assert.equal(reads.length, 2, String(end));
    assert.deepEqual(heard, ["retry_scheduled", end === null ? null : end], String(end));
  }
});

test("a finished run whose result is not on its way is not followed", async () => {
  for (const first of [sending("delivered"), sending("dead_lettered"), sending(null), run("completed")]) {
    const { reads, deps } = deliveryReads(["sending"]);
    await followDelivery("flow-1", "run-1", first, { signal: new AbortController().signal, onStatus: () => undefined, page: fakePage(false), online: createOnlineStatus(), deps });
    assert.equal(reads.length, 0, JSON.stringify(first));
  }
});

test("leaving the run calls off the read under way and reads nothing more for it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const controller = new AbortController();
  let reads = 0;
  const done = followDelivery("flow-1", "run-1", sending("sending"), {
    signal: controller.signal,
    onStatus: () => assert.fail("nothing is told after leaving"),
    page: fakePage(false),
    online: createOnlineStatus(),
    deps: {
      // A read that waits (for a new login, say) until it is called off.
      getStatus: (_flowId: string, _runId: string, signal?: AbortSignal) => {
        reads += 1;
        return new Promise<FlowRunSummary>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
    },
  });
  await pass(t, 2_000);
  assert.equal(reads, 1);
  controller.abort();
  // The read called off ends the following with its abort, which the page does not show.
  await done.catch(() => undefined);
  await pass(t, 60_000);
  assert.equal(reads, 1);
});

test("a status read that fails and can be tried again is said as trouble, tried again, and the trouble goes when a read goes through", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { reads, deps } = deliveryReads(["sending", new ApiError(503, "Service Unavailable", null), new TypeError("Failed to fetch"), "delivered"]);
  const trouble: boolean[] = [];
  const heard: unknown[] = [];
  const done = followDelivery("flow-1", "run-1", sending("sending"), {
    signal: new AbortController().signal,
    onStatus: (status) => heard.push(status.result_delivery?.state),
    onTrouble: (failing) => trouble.push(failing),
    page: fakePage(false),
    online: createOnlineStatus(),
    deps,
  });
  await pass(t, 4_000);
  assert.deepEqual(trouble, [true], "said from the first failed read");
  assert.deepEqual(heard, [], "a failed read says nothing of the sending");
  await pass(t, 10_000);
  await done;
  assert.equal(reads.length, 4);
  assert.deepEqual(trouble, [true, false]);
  assert.deepEqual(heard, ["delivered"]);
});

test("a run that is gone, or a read that is refused, ends the following with its error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  for (const status of [404, 410, 403]) {
    const { deps } = deliveryReads([new ApiError(status, "nej", null)]);
    const done = followDelivery("flow-1", "run-1", sending("sending"), {
      signal: new AbortController().signal,
      onStatus: () => undefined,
      page: fakePage(false),
      online: createOnlineStatus(),
      deps,
    });
    const settled = done.then(() => "resolved", (error: ApiError) => error.status);
    await pass(t, 2_000);
    assert.equal(await settled, status);
  }
});

test("a run whose status cannot be read is reported as in trouble from the first failed read until a read goes through", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const heard: boolean[] = [];
  const snapshots: RunSnapshot[] = [];
  const done = followRun("flow-1", "run-1", {
    signal: new AbortController().signal,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onTrouble: (failing) => heard.push(failing),
    page: fakePage(false),
    online: createOnlineStatus(),
    deps: {
      getStatus: async () => {
        reads += 1;
        if (reads === 1) throw new ApiError(503, "Service Unavailable", null);
        if (reads === 2) throw new TypeError("Failed to fetch");
        return run(reads === 3 ? "running" : "completed");
      },
      getGraph: async () => graph(null),
    },
  });

  await until(() => heard.length === 1);
  assert.deepEqual(heard, [true], "in trouble as soon as a read fails");
  t.mock.timers.tick(1_000);
  await until(() => reads === 2);
  await settle();
  assert.deepEqual(heard, [true], "a second failed read is no news");
  t.mock.timers.tick(2_000);
  await until(() => snapshots.length === 1);
  assert.deepEqual(heard, [true, false], "out of trouble when a read goes through");
  t.mock.timers.tick(VISIBLE_POLL_MS);
  assert.equal((await done)?.run.status, "completed");
  assert.deepEqual(heard, [true, false], "no news from reads that go through");
});
