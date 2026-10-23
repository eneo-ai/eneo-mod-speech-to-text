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
 * that the module does not answer of the rest. While the module does not
 * answer and the device has its network, the module is asked again by itself
 * (`probe`, after 5 s and then twice as long each time, at most a minute), so
 * a page whose next request is far off does not go on saying it does not
 * answer.
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

const FIRST_PROBE_MS = 5_000;
const LAST_PROBE_MS = 60_000;

/**
 * `probe` asks whether the module answers (true when it does); without one, only requests and the browser's events tell.
 */
export function createOnlineStatus(target?: OnlineTarget, now: () => number = () => performance.now(), probe?: () => Promise<boolean>): OnlineStatus {
  let browserOnline = target?.navigator.onLine ?? true;
  // When the browser last said there is no network: a page opened offline was told so before anything left it.
  let saidOffline = browserOnline ? null : -Infinity;
  let requestFailed = false;
  const listeners = new Set<(online: boolean) => void>();
  const connection = (): Connection => (!browserOnline ? "offline" : requestFailed ? "unreachable" : "online");
  // The next ask of the module, while it does not answer; the wait doubles with each ask that finds it still quiet.
  let probing = false;
  let wait = FIRST_PROBE_MS;
  const askLater = () => {
    if (!probe || probing || connection() !== "unreachable") return;
    probing = true;
    const timer = setTimeout(async () => {
      const sent = now();
      const answered = await probe().catch(() => false);
      probing = false;
      if (connection() !== "unreachable") return;
      if (answered) return reportReachable(sent);
      wait = Math.min(wait * 2, LAST_PROBE_MS);
      askLater();
    }, wait);
    // In Node (the unit tests) a pending ask does not keep the process alive; a browser's timer is a number.
    (timer as { unref?: () => void }).unref?.();
  };
  const change = (apply: () => void) => {
    const before = connection();
    apply();
    const after = connection();
    if (after !== "unreachable") wait = FIRST_PROBE_MS;
    if (after !== before) listeners.forEach((listener) => listener(after === "online"));
    askLater();
  };
  const reportReachable = (sent?: number) =>
    change(() => {
      requestFailed = false;
      if (!browserOnline && sent !== undefined && saidOffline !== null && sent > saidOffline) browserOnline = true;
    });

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
    reportReachable,
  };
}

/** The module's own health route answers: it is reached (a proxy's error page in front of it is not it). */
const moduleAnswers = () =>
  fetch("/api/healthz", { cache: "no-store", credentials: "same-origin" }).then(
    (response) => response.ok,
    () => false,
  );

export const onlineStatus = typeof window === "undefined" ? createOnlineStatus() : createOnlineStatus(window, undefined, moduleAnswers);

/** What a page says of each cause, in the same words wherever it says it. */
export const CONNECTION_LOST = {
  offline: "Ingen anslutning.",
  unreachable: "Tal till text svarar inte just nu.",
} as const;

/** Why a request did not reach the module, as a page says it: the device has no network, else the module does not answer. */
export function connectionLost(status: Pick<OnlineStatus, "connection"> = onlineStatus): string {
  return CONNECTION_LOST[status.connection === "offline" ? "offline" : "unreachable"];
}
