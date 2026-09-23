import assert from "node:assert/strict";
import test from "node:test";

import type { FlowGraph, FlowRunSummary } from "./api";
import { HIDDEN_POLL_MS, VISIBLE_POLL_MS, followRun, readFinishedRun, type PageVisibility, type RunSnapshot } from "./follow-run";
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

test("a finished run whose result or steps cannot be read says so, never shows an empty result", async (t) => {
  const original = globalThis.fetch;
  let failing = "";
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = String(url);
    if (failing && path.includes(failing)) return new Response(JSON.stringify({ detail: "fel" }), { status: 500 });
    const body = path.endsWith("/steps/") ? [] : { id: "run-1", flow_id: "flow-1", status: "completed", result: { kind: "inline_text", text: "Klart" } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const read = await readFinishedRun("flow-1", run("completed"));
  assert.equal(read.run.result?.kind, "inline_text");

  failing = "/runs/run-1/steps/";
  await assert.rejects(readFinishedRun("flow-1", run("completed")), "missing steps would hide the transcript and step results");
  failing = "/runs/run-1/";
  await assert.rejects(readFinishedRun("flow-1", run("completed")), "a missing detail would show Klart without the document");
});
