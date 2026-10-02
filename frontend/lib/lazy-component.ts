import { useEffect, useState } from "react";

/** One piece of code that a page fetches when it first needs it: kept once it has arrived, so the next use has it at once. */
export interface Loader<T> {
  /** The code, if it has arrived. */
  readonly loaded: T | null;
  /** Fetches it. Pages that ask while it is on its way share the one fetch; a failed fetch is not kept, so the next asks again. */
  load(): Promise<T>;
}

export function lazyLoader<T>(fetch: () => Promise<T>): Loader<T> {
  let loaded: T | null = null;
  let pending: Promise<T> | null = null;
  return {
    get loaded() {
      return loaded;
    },
    load() {
      pending ??= fetch().then(
        (code) => (loaded = code),
        (error) => {
          pending = null;
          throw error;
        },
      );
      return pending;
    },
  };
}

/**
 * The code of a loader, for a page that shows something else until it has arrived (a plain field, the text as it was
 * written). If the code cannot be fetched (a tab older than the deploy that replaced its files, a connection that
 * dropped) `failed` says so and `retry` fetches only that code again: never the page, which may hold work that is not
 * saved yet, and never a boundary that would unmount it.
 */
export function useLoaded<T>(loader: Loader<T>) {
  const [value, setValue] = useState<T | null>(() => loader.loaded);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (value) return;
    let current = true;
    setFailed(false);
    loader.load().then(
      // A function (a component) given to setState would be called as an update: wrapped, it is stored.
      (code) => current && setValue(() => code),
      () => current && setFailed(true),
    );
    return () => {
      current = false;
    };
  }, [loader, value, attempt]);
  return {
    value,
    failed,
    /** How many presses of retry the page has had: a first load is not one. */
    retries: attempt,
    /** Fetches the code again, if it failed. */
    retry: () => {
      if (failed) setAttempt(attempt + 1);
    },
  };
}
