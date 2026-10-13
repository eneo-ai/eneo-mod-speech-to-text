/**
 * The one owner of "are we online". The browser's online/offline events say
 * when the device loses its network; our own requests say when a network
 * that looks connected does not reach the module. A request that reaches the
 * module, or the browser coming back online, clears an earlier failure. An
 * answer from the module also outweighs a browser that says the device has no
 * network (Safari can go on saying so after a device wakes), when the request
 * left after the browser said it: an answer that was already on its way when
 * the network went says nothing of the network now. The two causes are told
 * apart (`connection`): a page says "no connection" only of the device, and
 * that the module does not answer of the rest.
 */

export type Connection = "online" | "offline" | "unreachable";

export interface OnlineStatus {
  readonly online: boolean;
  /** "offline": the device has no network. "unreachable": it has, and a request did not reach the module. */
  readonly connection: Connection;
  /** Heard when the connection changes, also from one cause to the other, with whether it is online now. */
  subscribe(listener: (online: boolean) => void): () => void;
  reportNetworkFailure(): void;
  /** The moment a request leaves, to give back with its answer (`reportReachable`). */
  sending(): number;
  /** A request reached the module. `sent`: when it left; without it the answer clears only an earlier failure. */
  reportReachable(sent?: number): void;
}

export interface OnlineTarget {
  navigator: { onLine: boolean };
  addEventListener(type: "online" | "offline", listener: () => void): void;
}

export function createOnlineStatus(target?: OnlineTarget, now: () => number = () => performance.now()): OnlineStatus {
  let browserOnline = target?.navigator.onLine ?? true;
  // When the browser last said there is no network: a page opened offline was told so before anything left it.
  let saidOffline = browserOnline ? null : -Infinity;
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
  target?.addEventListener("offline", () =>
    change(() => {
      browserOnline = false;
      saidOffline = now();
    }),
  );

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
    sending: now,
    reportReachable: (sent) =>
      change(() => {
        requestFailed = false;
        if (!browserOnline && sent !== undefined && saidOffline !== null && sent > saidOffline) browserOnline = true;
      }),
  };
}

export const onlineStatus = createOnlineStatus(
  typeof window === "undefined" ? undefined : window,
);
