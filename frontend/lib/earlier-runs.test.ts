import assert from "node:assert/strict";
import test from "node:test";

import type { FlowRunSummary, OffsetPaginatedResponse } from "./api";
import { EarlierRunsList } from "./earlier-runs";

const runs = (count: number): FlowRunSummary[] =>
  Array.from({ length: count }, (_, index) => ({ id: `run-${index + 1}`, flow_id: "flow-1", status: "completed" }));

/** Eneo's own-runs list: a page of `limit` from `offset`, and whether another follows. */
function eneoRuns(all: FlowRunSummary[]) {
  const asked: Array<{ limit: number; offset: number }> = [];
  let failNext = false;
  let held: Promise<void> | null = null;
  const list = async (_flowId: string, page: { limit: number; offset: number }) => {
    asked.push(page);
    if (failNext) {
      failNext = false;
      throw new TypeError("Failed to fetch");
    }
    const answer = held;
    held = null;
    await answer;
    const items = all.slice(page.offset, page.offset + page.limit);
    return { items, count: items.length, has_more: page.offset + page.limit < all.length } satisfies OffsetPaginatedResponse<FlowRunSummary>;
  };
  return {
    list,
    asked,
    failNextPage: () => (failNext = true),
    /** Holds the next answer until the returned function is called. */
    holdNextPage: () => {
      let release = () => {};
      held = new Promise((resolve) => (release = resolve));
      return release;
    },
  };
}

test("eleven runs: ten first, 'Visa fler körningar' adds the eleventh, and then there are no more", async () => {
  const eneo = eneoRuns(runs(11));
  const earlier = new EarlierRunsList("flow-1", eneo.list);
  await earlier.reload();
  assert.equal(earlier.getSnapshot().runs.length, 10);
  assert.equal(earlier.getSnapshot().hasMore, true);

  await Promise.all([earlier.more(), earlier.more()]); // a double click reads the page once
  assert.deepEqual(
    earlier.getSnapshot().runs.map((run) => run.id),
    runs(11).map((run) => run.id),
  );
  assert.equal(earlier.getSnapshot().hasMore, false);
  assert.deepEqual(eneo.asked, [
    { limit: 10, offset: 0 },
    { limit: 10, offset: 10 },
  ]);
});

test("a next page that fails keeps the ten shown and offers another try, which then adds the eleventh", async () => {
  const eneo = eneoRuns(runs(11));
  const earlier = new EarlierRunsList("flow-1", eneo.list);
  await earlier.reload();
  eneo.failNextPage();
  await earlier.more();
  assert.deepEqual(
    [earlier.getSnapshot().runs.length, earlier.getSnapshot().hasMore, earlier.getSnapshot().failed],
    [10, true, "next"],
  );

  await earlier.more();
  assert.deepEqual([earlier.getSnapshot().runs.length, earlier.getSnapshot().failed], [11, null]);
});

test("a first page that fails says so and is tried again; a refresh that fails keeps the rows shown and says so", async () => {
  const eneo = eneoRuns(runs(11));
  const earlier = new EarlierRunsList("flow-1", eneo.list);
  eneo.failNextPage();
  await earlier.reload();
  assert.deepEqual([earlier.getSnapshot().runs.length, earlier.getSnapshot().failed], [0, "first"]);
  await earlier.more(); // "Försök igen" reads the first page again
  assert.deepEqual([earlier.getSnapshot().runs.length, earlier.getSnapshot().failed], [10, null]);
  assert.deepEqual(eneo.asked.at(-1), { limit: 10, offset: 0 });

  eneo.failNextPage();
  await earlier.reload(); // after a conflict
  assert.deepEqual([earlier.getSnapshot().runs.length, earlier.getSnapshot().failed], [10, "first"]);
});

test("a run started between two pages shifts the next page, and no run is shown twice", async () => {
  const all = runs(22);
  const eneo = eneoRuns(all);
  const earlier = new EarlierRunsList("flow-1", eneo.list);
  await earlier.reload();
  all.unshift({ id: "run-new", flow_id: "flow-1", status: "queued" }); // run-10 moves to the second page
  await earlier.more();
  await earlier.more();
  const ids = earlier.getSnapshot().runs.map((run) => run.id);
  assert.deepEqual(ids, runs(22).map((run) => run.id), "each run once");
  assert.deepEqual(
    eneo.asked.map((page) => page.offset),
    [0, 10, 20],
    "the next page follows what Eneo gave, not what is shown",
  );
});

test("reading the list again starts from the first page, and a page still coming for the old list is dropped", async () => {
  const all = runs(11);
  const eneo = eneoRuns(all);
  const earlier = new EarlierRunsList("flow-1", eneo.list);
  await earlier.reload();
  const release = eneo.holdNextPage();
  const more = earlier.more(); // still on its way when the list is read again
  all.unshift({ id: "run-new", flow_id: "flow-1", status: "queued" });
  await earlier.reload();
  release(); // the old list's second page arrives after the new first page
  await more;
  assert.equal(earlier.getSnapshot().runs[0].id, "run-new", "the newest run first");
  assert.equal(earlier.getSnapshot().runs.length, 10, "one page again, without the old list's second page");
  assert.deepEqual(eneo.asked.at(-1), { limit: 10, offset: 0 });
});

test("a first page read again before the last read answered: both wait for the newest answer, whichever answers first", async () => {
  const eneo = eneoRuns(runs(3));
  const earlier = new EarlierRunsList("flow-1", eneo.list);
  const releaseFirst = eneo.holdNextPage();
  let firstDone = false;
  const first = earlier.reload().then(() => (firstDone = true));
  const releaseSecond = eneo.holdNextPage();
  const second = earlier.reload();
  releaseFirst(); // the replaced read answers first, and is dropped
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(firstDone, false, "the list is not known yet: the newest read has not answered");
  assert.equal(earlier.getSnapshot().loading, true);
  releaseSecond();
  await Promise.all([first, second]);
  assert.equal(earlier.getSnapshot().runs.length, 3, "known when either says so");
});

test("the runs waiting for this person's review: newest first as Eneo lists them, never a test run from Eneo's editor", async () => {
  const { pendingReviews } = await import("./earlier-runs");
  const run = (id: string, status: string, purpose?: string): FlowRunSummary => ({ id, flow_id: "flow-1", status, ...(purpose ? { purpose } : {}) });
  assert.deepEqual(pendingReviews([]), []);
  assert.deepEqual(pendingReviews([run("a", "completed"), run("b", "running")]), [], "nothing waits");
  assert.deepEqual(
    pendingReviews([run("new", "awaiting_review"), run("done", "completed"), run("test", "awaiting_review", "test"), run("old", "awaiting_review")]).map((r) => r.id),
    ["new", "old"],
  );
});
