/**
 * Browser back never loses a recording: while it is guarded, the page keeps
 * one extra history entry, so the back button lands on it. The guard puts
 * the entry back at once and asks, in the page's own dialog, through
 * `onAttempt`; its `leave` goes on back past the guard. Releasing the guard
 * takes the entry away again when it is still the current one, and the entry
 * below takes over an address the page wrote meanwhile (a started run's).
 */

const MARK = "talTillTextGuard";

type GuardWindow = Pick<Window, "history" | "location" | "addEventListener" | "removeEventListener">;

function isGuard(state: unknown): boolean {
  return typeof state === "object" && state !== null && MARK in state;
}

export function guardHistory(win: GuardWindow, onAttempt: (leave: () => void) => void): () => void {
  let active = true;
  const guarded = win.location.href;
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
    if (!isGuard(win.history.state)) return;
    const address = win.location.href;
    if (address !== guarded) {
      // Without the app router's own state, so the router takes the address over too and keeps it.
      win.addEventListener("popstate", () => win.history.replaceState(null, "", address), { once: true });
    }
    win.history.back();
  };
}

/**
 * Browser Back and Forward between the flow page and a run opened from its list (a history entry of its own):
 * `show` gets the run the address names, or null for the flow page. The address is read once the move has
 * settled, so a guard putting its entry back, or taking it away and restoring a started run's address, is no move.
 * Leaving the flow's page is the router's. Returns the stop.
 */
export function followRunAddress(
  win: GuardWindow,
  shown: () => string | null,
  show: (runId: string | null) => void,
): () => void {
  const path = new URL(win.location.href, "http://localhost").pathname;
  let settle: ReturnType<typeof setTimeout> | undefined;
  const onPopState = () => {
    clearTimeout(settle);
    settle = setTimeout(() => {
      const address = new URL(win.location.href, "http://localhost");
      if (address.pathname !== path) return;
      const runId = address.searchParams.get("run");
      if (runId !== shown()) show(runId);
    });
  };
  win.addEventListener("popstate", onPopState);
  return () => {
    clearTimeout(settle);
    win.removeEventListener("popstate", onPopState);
  };
}
