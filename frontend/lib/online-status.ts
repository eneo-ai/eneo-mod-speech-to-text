/**
 * The one owner of "are we online". The browser's online/offline events say
 * when the device loses its network; our own requests say when a network
 * that looks connected does not reach the module. A request that reaches the
 * module, or the browser coming back online, clears an earlier failure.
 */

export interface OnlineStatus {
  readonly online: boolean;
  subscribe(listener: (online: boolean) => void): () => void;
  reportNetworkFailure(): void;
  reportReachable(): void;
}

export interface OnlineTarget {
  navigator: { onLine: boolean };
  addEventListener(type: "online" | "offline", listener: () => void): void;
}

export function createOnlineStatus(target?: OnlineTarget): OnlineStatus {
  let browserOnline = target?.navigator.onLine ?? true;
  let requestFailed = false;
  const listeners = new Set<(online: boolean) => void>();
  const current = () => browserOnline && !requestFailed;
  const change = (apply: () => void) => {
    const before = current();
    apply();
    if (current() !== before) listeners.forEach((listener) => listener(current()));
  };

  target?.addEventListener("online", () =>
    change(() => {
      browserOnline = true;
      requestFailed = false;
    }),
  );
  target?.addEventListener("offline", () => change(() => (browserOnline = false)));

  return {
    get online() {
      return current();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reportNetworkFailure: () => change(() => (requestFailed = true)),
    reportReachable: () => change(() => (requestFailed = false)),
  };
}

export const onlineStatus = createOnlineStatus(
  typeof window === "undefined" ? undefined : window,
);
