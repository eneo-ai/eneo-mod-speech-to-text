/**
 * What someone has typed but not yet sent, kept per person in this tab
 * (sessionStorage), so a reload after a lost login, or a tab the browser put
 * to sleep, gives it back: the flow's details before a document is made, and
 * a review's edits before they are saved. Only to the same person: someone
 * else signing in here clears the others' drafts. Sent or saved, it goes.
 * What the storage refused is said to be unkept (`unstoredDrafts`), so leaving
 * the page asks first.
 */

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const PREFIX = "tal-till-text:draft:";
const key = (ownerId: string, what: string) => `${PREFIX}${ownerId}:${what}`;

// Drafts this tab could not keep, by key, until they are stored, sent or thrown away.
const unkept = new Set<string>();
const listeners = new Set<() => void>();
function keep(name: string, kept: boolean) {
  const before = unkept.size > 0;
  if (kept) unkept.delete(name);
  else unkept.add(name);
  if (before !== unkept.size > 0) listeners.forEach((listener) => listener());
}

/** Whether typed work on the page is kept nowhere but the page, which leaving would lose. */
export const unstoredDrafts = {
  any: (): boolean => unkept.size > 0,
  /** The page that held them is gone, and what it could not keep with it. */
  forget(): void {
    unkept.clear();
    listeners.forEach((listener) => listener());
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function readDraft<T>(storage: DraftStorage | null | undefined, ownerId: string, what: string): T | null {
  try {
    const raw = storage?.getItem(key(ownerId, what));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** False when the draft could not be kept: the page alone holds what was typed. */
export function writeDraft(storage: DraftStorage | null | undefined, ownerId: string, what: string, value: unknown): boolean {
  let kept = false;
  try {
    if (storage) {
      storage.setItem(key(ownerId, what), JSON.stringify(value));
      kept = true;
    }
  } catch {
    // A full or refused storage.
  }
  keep(key(ownerId, what), kept);
  return kept;
}

export function clearDraft(storage: DraftStorage | null | undefined, ownerId: string, what: string): void {
  keep(key(ownerId, what), true);
  try {
    storage?.removeItem(key(ownerId, what));
  } catch {
    // Nothing kept, nothing to clear.
  }
}

/** Someone signed in here: every other person's drafts go. */
export function keepOnlyDraftsOf(storage: DraftStorage | null | undefined, ownerId: string): void {
  try {
    if (!storage) return;
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const name = storage.key(index);
      if (name?.startsWith(PREFIX) && !name.startsWith(key(ownerId, ""))) storage.removeItem(name);
    }
  } catch {
    // A refused storage holds no drafts.
  }
}

/** This tab's sessionStorage, or null where the page may not use it. */
export function browserDrafts(): DraftStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}
