/**
 * Whether this page's login holds. Its end never navigates away: the page
 * stays with all it holds, a recording keeps capturing into the device store,
 * and AuthGate asks for a new login in place. A request that is safe to send
 * twice (a GET, or one with an Idempotency-Key) waits for that login and goes
 * again; any other fails, for the user to press again once signed in.
 */

import type { AuthStatus } from "./api";

export interface LoginState {
  readonly signedOut: boolean;
  subscribe(listener: () => void): () => void;
  /** A signed-in page from here on (AuthGate); the returned function ends it. */
  begin(): () => void;
  /** What the module's backend says of the login: signed in and until when, or signed out. */
  observe(status: AuthStatus): void;
  /** A request found the login ended (401 with X-Auth-Required: session). */
  ended(): void;
  /** True once signed in again; false at once where no signed-in page waits, or when `signal` ends the wait. */
  whenRenewed(signal?: AbortSignal | null): Promise<boolean>;
}

export function createLoginState(): LoginState {
  let pages = 0;
  let signedOut = false;
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  let waiting: Array<(renewed: boolean) => void> = [];
  const listeners = new Set<() => void>();

  const settle = (renewed: boolean) => {
    const waiters = waiting;
    waiting = [];
    waiters.forEach((resolve) => resolve(renewed));
  };
  const setSignedOut = (next: boolean) => {
    if (signedOut === next) return;
    signedOut = next;
    if (!next) settle(true);
    listeners.forEach((listener) => listener());
  };
  const ended = () => {
    if (pages > 0) setSignedOut(true);
  };

  return {
    get signedOut() {
      return signedOut;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    begin() {
      pages += 1;
      let open = true;
      return () => {
        if (!open) return;
        open = false;
        pages -= 1;
        if (pages > 0) return;
        clearTimeout(endTimer);
        settle(false);
        setSignedOut(false);
      };
    },
    observe(status) {
      clearTimeout(endTimer);
      if (!status.authenticated) return ended();
      setSignedOut(false);
      // The login ends at this time whatever the page does; only a new login moves it.
      if (status.session_ends_in !== undefined) endTimer = setTimeout(ended, status.session_ends_in * 1000);
    },
    ended,
    whenRenewed(signal) {
      if (pages === 0 || signal?.aborted) return Promise.resolve(false);
      if (!signedOut) return Promise.resolve(true);
      return new Promise((resolve) => {
        waiting.push(resolve);
        signal?.addEventListener("abort", () => resolve(false), { once: true });
      });
    },
  };
}

export const loginState = createLoginState();
