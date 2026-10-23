import { useEffect, useState } from "react";
import { onlineStatus, type OnlineStatus } from "@/lib/online-status";

/** One piece of code that a page fetches when it first needs it: kept once it has arrived, so the next use has it at once. */
export interface Loader<T> {
  /** The code, if it has arrived. */
  readonly loaded: T | null;
  /**
   * Gets it. Pages that ask while it is on its way share the one request. A failure is kept too: a browser keeps a failed
   * fetch of a module per address, so asking again could not fetch it. That is also why nothing is fetched while the
   * device has no network: the one fetch the page gets waits until the network is back.
   */
  load(): Promise<T>;
}

/**
 * Resolves at once, or when the device has a network again: what a page awaits before it imports code it has not loaded,
 * since an import that fails offline fails for the rest of the page's life.
 */
export function whenConnected(online: Pick<OnlineStatus, "connection" | "subscribe"> = onlineStatus) {
  if (online.connection !== "offline") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const stop = online.subscribe(() => {
      if (online.connection === "offline") return;
      stop();
      resolve();
    });
  });
}

export function lazyLoader<T>(get: () => Promise<T>, online: Pick<OnlineStatus, "connection" | "subscribe"> = onlineStatus): Loader<T> {
  let loaded: T | null = null;
  let pending: Promise<T> | null = null;
  return {
    get loaded() {
      return loaded;
    },
    load() {
      pending ??= whenConnected(online)
        .then(get)
        .then((code) => (loaded = code));
      return pending;
    },
  };
}

/**
 * The code of a loader, for a page that shows something else until it has arrived (a plain field, the text as it was
 * written). If the code cannot be fetched (a tab older than the deploy that replaced its files, a connection that
 * dropped) `failed` says so, and the page offers the person's own reload (LoadFailure): never a reload by itself, since
 * the page may hold work that is not saved yet, and never a boundary that would unmount it.
 */
export function useLoaded<T>(loader: Loader<T>) {
  const [value, setValue] = useState<T | null>(() => loader.loaded);
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
  }, [loader, value]);
  return { value, failed };
}
