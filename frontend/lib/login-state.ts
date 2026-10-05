/**
 * Whether this page's login holds. Its end never navigates away: the page
 * stays with all it holds, a recording keeps capturing into the device store,
 * and AuthGate asks for a new login in place. Only the page's own user signing
 * in again ends that: someone else's login keeps the page covered. Until then
 * nothing is sent from it (api.ts): a request that is safe to send twice (a
 * GET, or one with an Idempotency-Key) waits for the new login and goes; any
 * other fails, for the user to press again once signed in.
 *
 * Answers come back in any order: a request sent under a login that a renewal
 * has since replaced may be refused late, and a status read asked before the
 * end may say "signed in" after it. The state is the one owner of the login's
 * revision, so neither moves it (`Question`). The shape follows the module
 * kit's session state (packages/ui/src/session/state.ts), which this module
 * moves onto.
 */

import type { AuthenticatedUser, AuthStatus } from "./api";
import { sessionUser } from "./user-identity";

/**
 * What a question to the backend (a status read, a request, a socket) remembers of the login when it was asked, to
 * tell when its answer comes whether it is still about the login the page has: the login's revision, and the
 * question's place among the questions.
 */
export interface Question {
  readonly revision: number;
  readonly order: number;
}

interface LoginState {
  readonly signedOut: boolean;
  /**
   * The user the page was opened for, which the page names in what it sends to Eneo (api.ts) and to the live relay:
   * the module refuses a request whose session is someone else's. Null where no page is open.
   */
  readonly expectedUser: string | null;
  /** The most the module takes in one upload, as its status said last (getRunContract holds the files to it); null before. */
  readonly maxUploadBytes: number | null;
  /** Who is signed in instead of the page's user, while the page stays covered for them. */
  readonly otherUser: AuthenticatedUser | null;
  subscribe(listener: () => void): () => void;
  /**
   * A page signed in as `owner` from here on (AuthGate); `reread` reads the status again (see userChanged); the
   * returned function ends it.
   */
  begin(owner: AuthenticatedUser, reread?: () => void): () => void;
  /** Starts a question to the backend: ask before sending, and give the question back with its answer. */
  ask(): Question;
  /**
   * What the module's backend says of the login: signed in and until when, or signed out. False, and nothing changes,
   * when the answer belongs to a question asked before the login changed or before one already answered: it is about
   * a login that is gone. Without a question, it is taken as asked now.
   */
  observe(status: AuthStatus, question?: Question): boolean;
  /**
   * A request found the login ended (401 with X-Auth-Required: session). False, and nothing changes, when the
   * request was sent before the login changed: the refusal is about the old login, not the page's. Without a
   * question, the login is ended.
   */
  ended(question?: Question): boolean;
  /**
   * The session is not the page's user's any more: the module found it someone else's (409 user_changed, the live
   * relay's close of that name), or it ended under an open socket, which another person's login may have done
   * (close session_ended). The page is covered as for an end, and the status is read again, which says whose
   * session it is. False, and nothing changes, for a question asked before the login changed.
   */
  userChanged(question?: Question): boolean;
  /**
   * A login window of the module says it is done (AuthGate hears it on the session channel): a new login is announced, also when the page was never covered. Everything asked before is about the
   * old login from now on, whenever its answer comes, and so is the old session's end time; the status read asked
   * next decides (the page's own user uncovers it, someone else's covers it).
   */
  loginWindowDone(): void;
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
  // The one revision of the login: it changes whenever the login does (ended, signed in again, someone else's, a new
  // login announced). A question's answer counts only under the revision it was asked in, and only if no later status
  // question has been answered: so a late answer never undoes what a newer one, or the end itself, has settled.
  let revision = 0;
  let asked = 0;
  let answered = 0;
  let maxUploadBytes: number | null = null;
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
  const ended = (question?: Question) => {
    if (question && question.revision !== revision) return false;
    if (pages > 0) setSignedOut(true);
    return true;
  };
  const ask = (): Question => ({ revision, order: ++asked });

  return {
    get signedOut() {
      return signedOut;
    },
    get otherUser() {
      return otherUser;
    },
    get expectedUser() {
      return owner ? owner.id : null;
    },
    get maxUploadBytes() {
      return maxUploadBytes;
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
    ask,
    observe(status, question = ask()) {
      if (question.revision !== revision || question.order <= answered) return false;
      answered = question.order;
      if (status.max_upload_bytes !== undefined) maxUploadBytes = status.max_upload_bytes;
      clearTimeout(endTimer);
      const user = sessionUser(status);
      if (!user) {
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
      if (status.session_ends_in !== undefined) endTimer = setTimeout(() => ended(), status.session_ends_in * 1000);
      return true;
    },
    ended,
    userChanged(question) {
      if (question && question.revision !== revision) return false;
      ended();
      if (pages > 0) reread?.();
      return true;
    },
    loginWindowDone() {
      // Early renewal replaces the session (the backend deletes the old one) with no cover to show for it, and the
      // status cannot always tell the logins apart (Eneo's ceiling may end both): so the announcement itself is the
      // change. What was asked before it, and the old deadline, no longer count; nothing is covered by them.
      revision += 1;
      clearTimeout(endTimer);
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
