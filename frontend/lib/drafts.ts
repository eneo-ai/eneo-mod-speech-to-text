/**
 * What someone has typed but not yet sent, kept per person in this tab
 * (sessionStorage), so a reload after a lost login, or a tab the browser put
 * to sleep, gives it back: the flow's details before a document is made, and
 * a review's edits before they are saved. Only to the same person: someone
 * else signing in here clears the others' drafts. Sent or saved, it goes.
 */

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const PREFIX = "tal-till-text:draft:";
const key = (ownerId: string, what: string) => `${PREFIX}${ownerId}:${what}`;

export function readDraft<T>(storage: DraftStorage | null | undefined, ownerId: string, what: string): T | null {
  try {
    const raw = storage?.getItem(key(ownerId, what));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeDraft(storage: DraftStorage | null | undefined, ownerId: string, what: string, value: unknown): void {
  try {
    storage?.setItem(key(ownerId, what), JSON.stringify(value));
  } catch {
    // A full or refused storage keeps no draft; the page still holds what was typed.
  }
}

export function clearDraft(storage: DraftStorage | null | undefined, ownerId: string, what: string): void {
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
