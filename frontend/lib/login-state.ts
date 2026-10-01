/**
 * Whether this page's login holds. Its end never navigates away: the page
 * stays with all it holds, a recording keeps capturing into the device store,
 * and AuthGate asks for a new login in place. Only the page's own user signing
 * in again ends that: someone else's login keeps the page covered. Until then
 * nothing is sent from it (api.ts): a request that is safe to send twice (a
 * GET, or one with an Idempotency-Key) waits for the new login and goes; any
 * other fails, for the user to press again once signed in.
 */

import type { AuthenticatedUser, AuthStatus } from "./api";
import { ACCESS_CODE_USER, sessionUser } from "./user-identity";

export interface LoginState {
  readonly signedOut: boolean;
  /**
   * The user the page was opened for, which the page names in what it sends to Eneo (api.ts) and to the live relay:
   * the module refuses a request whose session is someone else's. Null where no page is open, and for the access
   * code, which has no user.
   */
  readonly expectedUser: string | null;
  /** Who is signed in instead of the page's user, while the page stays covered for them. */
  readonly otherUser: AuthenticatedUser | null;
  subscribe(listener: () => void): () => void;
  /**
   * A page signed in as `owner` from here on (AuthGate); `reread` reads the status again (see userChanged); the
   * returned function ends it.
   */
  begin(owner: AuthenticatedUser, reread?: () => void): () => void;
  /** What the module's backend says of the login: signed in and until when, or signed out. */
  observe(status: AuthStatus): void;
  /** A request found the login ended (401 with X-Auth-Required: session). */
  ended(): void;
  /**
   * The module found the session someone else's (409 user_changed, or the live relay's close of that name): the
   * page is covered as for an end, and the status is read again, which says whose session it is.
   */
  userChanged(): void;
  /** True once signed in again; false at once where no signed-in page waits, or when `signal` ends the wait. */
  whenRenewed(signal?: AbortSignal | null): Promise<boolean>;
}

export function createLoginState(): LoginState {
  let pages = 0;
  let owner: AuthenticatedUser | null = null;
  let reread: (() => void) | undefined;
  let signedOut = false;
  let otherUser: AuthenticatedUser | null = null;
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  let waiting: Array<(renewed: boolean) => void> = [];
  const listeners = new Set<() => void>();

  const settle = (renewed: boolean) => {
    const waiters = waiting;
    waiting = [];
    waiters.forEach((resolve) => resolve(renewed));
  };
  const setSignedOut = (next: boolean, other: AuthenticatedUser | null = null) => {
    if (signedOut === next && otherUser?.id === other?.id) return;
    signedOut = next;
    otherUser = other;
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
    get otherUser() {
      return otherUser;
    },
    get expectedUser() {
      return owner && owner.id !== ACCESS_CODE_USER.id ? owner.id : null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    begin(user, read) {
      owner = user;
      reread = read;
      pages += 1;
      let open = true;
      return () => {
        if (!open) return;
        open = false;
        pages -= 1;
        if (pages > 0) return;
        owner = null;
        reread = undefined;
        clearTimeout(endTimer);
        settle(false);
        setSignedOut(false);
      };
    },
    observe(status) {
      clearTimeout(endTimer);
      const user = sessionUser(status);
      if (!user) return ended();
      // Someone else's login is not this page's: it stays covered, and nothing waiting goes out as them.
      if (pages > 0 && owner && user.id !== owner.id) return setSignedOut(true, user);
      setSignedOut(false);
      // The login ends at this time whatever the page does; only a new login moves it.
      if (status.session_ends_in !== undefined) endTimer = setTimeout(ended, status.session_ends_in * 1000);
    },
    ended,
    userChanged() {
      ended();
      if (pages > 0) reread?.();
    },
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
