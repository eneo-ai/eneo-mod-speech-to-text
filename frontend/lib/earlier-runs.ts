/**
 * This user's earlier runs of a flow, one bounded page at a time: "Visa fler
 * körningar" adds the next page while Eneo says more follow. The list is a
 * shortcut, so a page that cannot be read keeps what is shown.
 */

import { listOwnRuns, type FlowRunSummary } from "./api";

const EARLIER_RUNS_PAGE = 10;

/**
 * The runs among `runs` that wait for this person's review, in the list's order (the newest first). A test run started
 * from Eneo's editor is not this person's to review.
 */
export function pendingReviews(runs: readonly FlowRunSummary[]): FlowRunSummary[] {
  return runs.filter((run) => run.status === "awaiting_review" && run.purpose !== "test");
}

/**
 * The setup's latest runs, at its top: those waiting for this person's review first, then the newest, `count` at most;
 * with `waitingOnly` (a short screen, whose first screen is the ways in's) only those waiting. Never a test run.
 */
export function latestRuns(runs: readonly FlowRunSummary[], { waitingOnly = false, count = 3 } = {}): FlowRunSummary[] {
  const waiting = pendingReviews(runs);
  const rest = waitingOnly ? [] : runs.filter((run) => run.purpose !== "test" && !waiting.includes(run));
  return [...waiting, ...rest].slice(0, count);
}

/**
 * Whether the list of earlier runs has more to show than `latest`, the setup's latest runs: more runs, more in Eneo, or a
 * read to try again. Where it has not, the latest runs are the list.
 */
export function listsMore(list: EarlierRunsSnapshot, latest: readonly FlowRunSummary[]): boolean {
  return list.hasMore || list.failed !== null || list.runs.filter((run) => run.purpose !== "test").length > latest.length;
}

export interface EarlierRunsSnapshot {
  runs: readonly FlowRunSummary[];
  /** Eneo has more of them than are shown. */
  hasMore: boolean;
  loading: boolean;
  /** The first page (a read or a refresh) or the next one could not be read: offer another try. */
  failed: "first" | "next" | null;
}

export class EarlierRunsList {
  private snapshot: EarlierRunsSnapshot = { runs: [], hasMore: false, loading: false, failed: null };
  // Where Eneo's next page starts: the runs it gave, which a run started meanwhile makes differ from those shown.
  private offset = 0;
  private listeners = new Set<() => void>();
  // Bumped when the list is read again: a page still coming for the old list is dropped.
  private generation = 0;

  constructor(
    private readonly flowId: string,
    private readonly list: (flowId: string, page: { limit: number; offset: number }) => ReturnType<typeof listOwnRuns> = listOwnRuns,
  ) {}

  getSnapshot = (): EarlierRunsSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** From the first page again: the newest runs come first, a new one among them. */
  reload(): Promise<void> {
    this.generation += 1;
    return this.read(0, []);
  }

  /** "Visa fler körningar": the next page; after a first page that failed, that page again. */
  more(): Promise<void> {
    const { loading, hasMore, runs, failed } = this.snapshot;
    if (failed === "first") return this.reload();
    if (loading || !hasMore) return Promise.resolve();
    return this.read(this.offset, runs);
  }

  private async read(offset: number, shown: readonly FlowRunSummary[]) {
    const generation = this.generation;
    // A read that failed is said until one succeeds: another try keeps its words and the list that holds them.
    this.set({ loading: true });
    try {
      const page = await this.list(this.flowId, { limit: EARLIER_RUNS_PAGE, offset });
      if (generation !== this.generation) return;
      const items = page.items ?? [];
      this.offset = offset + items.length;
      // A run started since the first page moves older ones onto the next: each run is shown once.
      const known = new Set(shown.map((run) => run.id));
      const runs = [...shown, ...items.filter((run) => !known.has(run.id))];
      this.set({ runs, hasMore: page.has_more, loading: false, failed: null });
    } catch {
      if (generation !== this.generation) return;
      // What is shown stays; the view says the read failed.
      this.set({ loading: false, failed: offset === 0 ? "first" : "next" });
    }
  }

  private set(patch: Partial<EarlierRunsSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}
