/**
 * Browser back never loses a recording: while it is guarded, the page keeps
 * one extra history entry, so the back button lands on it. The guard puts
 * the entry back at once and asks, in the page's own dialog, through
 * `onAttempt`; its `leave` goes on back past the guard. Releasing the guard
 * takes the entry away again when it is still the current one.
 */

const MARK = "talTillTextGuard";

type GuardWindow = Pick<Window, "history" | "addEventListener" | "removeEventListener">;

function isGuard(state: unknown): boolean {
  return typeof state === "object" && state !== null && MARK in state;
}

export function guardHistory(win: GuardWindow, onAttempt: (leave: () => void) => void): () => void {
  let active = true;
  // No URL: the app router copies its own state and does not navigate.
  const push = () => win.history.pushState({ ...(win.history.state ?? {}), [MARK]: true }, "");
  const stop = () => {
    active = false;
    win.removeEventListener("popstate", onPopState);
  };
  const onPopState = () => {
    if (!active || isGuard(win.history.state)) return;
    // Stay guarded while the question is open; leaving then steps past the guard.
    push();
    onAttempt(() => {
      stop();
      win.history.go(-2);
    });
  };
  push();
  win.addEventListener("popstate", onPopState);
  return () => {
    if (!active) return;
    stop();
    if (isGuard(win.history.state)) win.history.back();
  };
}
