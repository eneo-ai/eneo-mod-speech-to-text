/**
 * This user's earlier runs of a flow, one bounded page at a time: "Visa fler
 * körningar" adds the next page while Eneo says more follow. The list is a
 * shortcut, so a page that cannot be read keeps what is shown.
 */

import { listOwnRuns, type FlowRunSummary } from "./api";

export const EARLIER_RUNS_PAGE = 10;

export interface EarlierRunsSnapshot {
  runs: readonly FlowRunSummary[];
  /** Eneo has more of them than are shown. */
  hasMore: boolean;
  loading: boolean;
  /** The next page could not be read: offer another try. */
  failed: boolean;
}

export class EarlierRunsList {
  private snapshot: EarlierRunsSnapshot = { runs: [], hasMore: false, loading: false, failed: false };
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

  /** "Visa fler körningar": the next page, after what is shown. */
  more(): Promise<void> {
    const { loading, hasMore, runs } = this.snapshot;
    if (loading || !hasMore) return Promise.resolve();
    return this.read(runs.length, runs);
  }

  private async read(offset: number, shown: readonly FlowRunSummary[]) {
    const generation = this.generation;
    this.set({ loading: true, failed: false });
    try {
      const page = await this.list(this.flowId, { limit: EARLIER_RUNS_PAGE, offset });
      if (generation !== this.generation) return;
      this.set({ runs: [...shown, ...(page.items ?? [])], hasMore: page.has_more, loading: false });
    } catch {
      if (generation !== this.generation) return;
      this.set({ loading: false, failed: offset > 0 });
    }
  }

  private set(patch: Partial<EarlierRunsSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}
