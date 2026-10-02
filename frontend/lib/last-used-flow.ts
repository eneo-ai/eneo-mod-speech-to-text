import type { KeyValueStorage } from "./browser-storage";

/** Where this browser remembers the flow a user last recorded, streamed or uploaded with. */
export const lastFlowKey = (ownerId: string) => `tal-till-text:${ownerId}:last-flow`;

/** The flow this user last recorded, streamed or uploaded with in this browser. */
export function lastUsedFlow(storage: KeyValueStorage | null | undefined, ownerId: string): string | null {
  try {
    return storage?.getItem(lastFlowKey(ownerId)) ?? null;
  } catch {
    return null;
  }
}

/** The flow list with the last used flow first; the rest keep their order. */
export function withLastUsedFirst<T extends { id: string }>(flows: T[], lastId: string | null): T[] {
  const last = flows.find((flow) => flow.id === lastId);
  return last ? [last, ...flows.filter((flow) => flow !== last)] : flows;
}
