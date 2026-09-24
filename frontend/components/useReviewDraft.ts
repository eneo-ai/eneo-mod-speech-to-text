"use client";

import { useState } from "react";
import { browserDrafts, clearDraft, readDraft, writeDraft } from "@/lib/drafts";

type Kept<T> = { revision: number; edit: T };

/**
 * A review's unsaved edit, kept for this person through a reload and given back on the revision it was made on.
 * Once the review has changed since (a save refused as out of date, a save from another tab), the edit is neither
 * applied to the latest nor thrown away by itself: it waits as "din version" until the user takes it or lets it go.
 */
export function useReviewDraft<T>(ownerId: string, name: string, revision: number) {
  // Bumped by whatever changes the kept edits, so the page reads them again.
  const [, setChanged] = useState(0);
  const storage = browserDrafts();
  const yoursName = `${name}:din`;
  // Read when asked: a handler may take din version and keep an edit in one go.
  const read = () => {
    const current = readDraft<Kept<T>>(storage, ownerId, name);
    const stale = current !== null && current.revision !== revision;
    return {
      initial: stale ? null : (current?.edit ?? null),
      yours: stale ? current.edit : readDraft<T>(storage, ownerId, yoursName),
      stale,
    };
  };
  const done = <R,>(result: R): R => {
    setChanged((count) => count + 1);
    return result;
  };
  const { initial, yours } = read();

  return {
    /** The edit to start the editor from, on this revision. */
    initial,
    /** The user's edit of an older revision, waiting beside the latest. */
    yours,
    /** The editor's current edit, on this revision; false when the browser could not keep it. */
    keep(edit: T): boolean {
      const now = read();
      // An edit of an older revision moves aside first, never written over.
      if (now.stale) {
        writeDraft(storage, ownerId, yoursName, now.yours);
        clearDraft(storage, ownerId, name);
      }
      return done(writeDraft(storage, ownerId, name, { revision, edit }));
    },
    /** The current edit is saved, or thrown away with Avbryt; din version stays. */
    drop() {
      if (!read().stale) clearDraft(storage, ownerId, name);
      done(undefined);
    },
    /** "Använd din version": handed over for the editor, which keeps it as its current edit. */
    takeYours(): T | null {
      const now = read();
      if (now.stale) clearDraft(storage, ownerId, name);
      clearDraft(storage, ownerId, yoursName);
      return done(now.yours);
    },
    /** "Behåll den senaste". */
    dropYours() {
      if (read().stale) clearDraft(storage, ownerId, name);
      clearDraft(storage, ownerId, yoursName);
      done(undefined);
    },
  };
}
