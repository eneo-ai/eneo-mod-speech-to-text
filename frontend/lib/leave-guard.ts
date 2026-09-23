/**
 * Browser back never loses a recording: while it is guarded, the page keeps
 * one extra history entry, so the back button lands on it and asks first.
 * Staying puts the entry back; leaving goes on back. Releasing the guard
 * takes the entry away again when it is still the current one.
 */

const MARK = "talTillTextGuard";

type GuardWindow = Pick<Window, "history" | "addEventListener" | "removeEventListener">;

function isGuard(state: unknown): boolean {
  return typeof state === "object" && state !== null && MARK in state;
}

export function guardHistory(
  win: GuardWindow,
  message: string,
  confirm: (message: string) => boolean,
): () => void {
  let active = true;
  // No URL: the app router copies its own state and does not navigate.
  const push = () => win.history.pushState({ ...(win.history.state ?? {}), [MARK]: true }, "");
  const onPopState = () => {
    if (!active || isGuard(win.history.state)) return;
    if (confirm(message)) {
      active = false;
      win.removeEventListener("popstate", onPopState);
      win.history.back();
    } else {
      push();
    }
  };
  push();
  win.addEventListener("popstate", onPopState);
  return () => {
    if (!active) return;
    active = false;
    win.removeEventListener("popstate", onPopState);
    if (isGuard(win.history.state)) win.history.back();
  };
}
