/**
 * Whether this page's login holds. Its end never navigates away: the page
 * stays with all it holds, a recording keeps capturing into the device store,
 * and AuthGate asks for a new login in place. Only the page's own user signing
 * in again ends that: someone else's login keeps the page covered. Until then
 * nothing is sent from it (api.ts): a request that is safe to send twice (a
 * GET, or one with an Idempotency-Key) waits for the new login and goes; any
 * other fails, for the user to press again once signed in.
 *
 * Answers come back late and out of order, so the login has a revision. A
 * request, a status read or a socket records it when it starts and hands it
 * back with what it found: a result from an older revision describes a login
 * that has changed since (the late 401 of a request sent on the old cookie, a
 * status read that went out while signed in), and never changes the state.
 * This is the only ordering of results against the login. A new login by the
 * same person while the page is not covered (an early renewal replaces the
 * session, and the backend deletes the old one) is no cover and no uncover,
 * so it is told by the session's end moving: what was sent on the old session
 * is stale from then on.
 */

import type { AuthenticatedUser, AuthStatus } from "./api";
import { ACCESS_CODE_USER, sessionUser } from "./user-identity";

/**
 * How far a new login moves the end of the session: the backend fixes it at the login (the token's refresh leaves it),
 * so the same session read again moves it by the request's second or so.
 */
export const NEW_LOGIN_MOVES_END_MS = 60_000;

export interface LoginState {
  readonly signedOut: boolean;
  /** Counts the changes of the login: covered, uncovered, another user signed in instead, or a new login by the same one. */
  readonly revision: number;
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
  /**
   * What the module's backend says of the login: signed in and until when, or signed out. `revision` is the one
   * the read started under; false when the answer was too old to be used.
   */
  observe(status: AuthStatus, revision?: number): boolean;
  /** A request found the login ended (401 with X-Auth-Required: session); `revision` as for observe. */
  ended(revision?: number): void;
  /**
   * The session is not the page's user's any more: the module found it someone else's (409 user_changed, the live
   * relay's close of that name), or it ended under an open socket, which another person's login may have done
   * (close session_ended). The page is covered as for an end, and the status is read again, which says whose
   * session it is. `revision` as for observe.
   */
  userChanged(revision?: number): void;
  /** True once signed in again; false at once where no signed-in page waits, or when `signal` ends the wait. */
  whenRenewed(signal?: AbortSignal | null): Promise<boolean>;
}

export function createLoginState(): LoginState {
  let pages = 0;
  let owner: AuthenticatedUser | null = null;
  let reread: (() => void) | undefined;
  let signedOut = false;
  let revision = 0;
  // When the login last read ends, from its status; a later status that moves it far is a new login.
  let endsAt: number | null = null;
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
    revision += 1;
    if (!next) settle(true);
    listeners.forEach((listener) => listener());
  };
  // Started under an older revision: the result describes a login that has changed since.
  const stale = (started?: number) => started !== undefined && started !== revision;
  const ended = (started?: number) => {
    if (pages > 0 && !stale(started)) setSignedOut(true);
  };

  return {
    get signedOut() {
      return signedOut;
    },
    get revision() {
      return revision;
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
        endsAt = null;
        clearTimeout(endTimer);
        settle(false);
        setSignedOut(false);
      };
    },
    observe(status, started) {
      if (stale(started)) return false;
      clearTimeout(endTimer);
      const user = sessionUser(status);
      if (!user) {
        endsAt = null;
        ended();
        return true;
      }
      // Someone else's login is not this page's: it stays covered, and nothing waiting goes out as them.
      if (pages > 0 && owner && user.id !== owner.id) {
        setSignedOut(true, user);
        return true;
      }
      setSignedOut(false);
      // The login ends at this time whatever the page does; only a new login moves it.
      if (status.session_ends_in !== undefined) {
        const end = Date.now() + status.session_ends_in * 1000;
        // A new login by the same person, seen while the page was not covered: what went out on the old session is
        // stale (its answers are the old session's, which the backend deleted).
        if (endsAt !== null && Math.abs(end - endsAt) >= NEW_LOGIN_MOVES_END_MS) revision += 1;
        endsAt = end;
        endTimer = setTimeout(() => ended(), status.session_ends_in * 1000);
      }
      return true;
    },
    ended,
    userChanged(started) {
      if (stale(started)) return;
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
