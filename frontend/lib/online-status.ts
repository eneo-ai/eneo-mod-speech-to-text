/**
 * The one owner of "are we online". The browser's online/offline events say
 * when the device loses its network; our own requests say when a network
 * that looks connected does not reach the module. A request that reaches the
 * module, or the browser coming back online, clears an earlier failure. The two
 * causes are told apart (`connection`): a page says "no connection" only of the
 * device, and that the module does not answer of the rest.
 */

export type Connection = "online" | "offline" | "unreachable";

export interface OnlineStatus {
  readonly online: boolean;
  /** "offline": the device has no network. "unreachable": it has, and a request did not reach the module. */
  readonly connection: Connection;
  /** Heard when the connection changes, also from one cause to the other, with whether it is online now. */
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
  const connection = (): Connection => (!browserOnline ? "offline" : requestFailed ? "unreachable" : "online");
  const change = (apply: () => void) => {
    const before = connection();
    apply();
    if (connection() !== before) listeners.forEach((listener) => listener(connection() === "online"));
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
      return connection() === "online";
    },
    get connection() {
      return connection();
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
