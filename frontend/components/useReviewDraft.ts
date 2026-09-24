"use client";

import { useRef, useState } from "react";
import { browserDrafts, clearDraft, readDraft, writeDraft } from "@/lib/drafts";

type Kept<T> = { revision: number; edit: T };
type Edits<T> = { current: Kept<T> | null; yours: T | null };

/**
 * A review's unsaved edit, given back on the revision it was made on. Once the review has changed since (a save
 * refused as out of date, a save from another tab), the edit is neither applied to the latest nor thrown away by
 * itself: it waits as "din version" until the user takes it or lets it go. The edits live in the page; the browser
 * keeps a copy for a reload where it can, and a kept copy goes only once what replaces it is written.
 */
export function useReviewDraft<T>(ownerId: string, name: string, revision: number) {
  const [, setChanged] = useState(0);
  const storage = browserDrafts();
  const yoursName = `${name}:din`;
  const edits = useRef<(Edits<T> & { name: string }) | null>(null);
  if (edits.current?.name !== name) {
    edits.current = { name, current: readDraft<Kept<T>>(storage, ownerId, name), yours: readDraft<T>(storage, ownerId, yoursName) };
  }
  // An edit of an older revision is din version.
  const settled = (): Edits<T> => {
    const { current, yours } = edits.current!;
    return current && current.revision !== revision ? { current: null, yours: current.edit } : { current, yours };
  };
  const change = (next: Edits<T>): boolean => {
    edits.current = { name, ...next };
    setChanged((count) => count + 1);
    const stored = readDraft<Kept<T>>(storage, ownerId, name);
    // The kept edit of an older revision is din version's only kept copy until din version is written.
    const storedIsYours = stored !== null && stored.revision !== revision;
    if (next.yours !== null && !writeDraft(storage, ownerId, yoursName, next.yours) && storedIsYours) return false;
    const kept = next.current ? writeDraft(storage, ownerId, name, next.current) : (clearDraft(storage, ownerId, name), true);
    if (next.yours === null && kept) clearDraft(storage, ownerId, yoursName);
    return kept;
  };
  const { current, yours } = settled();

  return {
    /** The edit to start the editor from, on this revision. */
    initial: current?.edit ?? null,
    /** The user's edit of an older revision, waiting beside the latest. */
    yours,
    /** The editor's current edit, on this revision; false when the browser could not keep it. */
    keep: (edit: T): boolean => change({ current: { revision, edit }, yours: settled().yours }),
    /**
     * The current edit is saved, or thrown away with Avbryt; din version stays. Given the version that was saved,
     * a newer edit than it is kept.
     */
    drop: (saved?: T) => {
      const { current, yours } = settled();
      if (saved !== undefined && current && JSON.stringify(current.edit) !== JSON.stringify(saved)) return;
      change({ current: null, yours });
    },
    /** "Använd din version": it becomes the editor's current edit, and is handed over to show. */
    takeYours(): T | null {
      const taken = settled().yours;
      if (taken !== null) change({ current: { revision, edit: taken }, yours: null });
      return taken;
    },
    /** "Behåll den senaste". */
    dropYours: () => void change({ current: settled().current, yours: null }),
  };
}
