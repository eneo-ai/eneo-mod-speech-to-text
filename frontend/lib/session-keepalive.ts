import type { AuthStatus } from "./api";

// Efter ett nätverksfel frågar sidan igen efter en stund.
const RETRY_MS = 10_000;

/**
 * Frågar efter sessionen när backend vill förnya Eneo-token (`refresh_in`),
 * så att även en lång inspelning utan andra anrop behåller sin session. Nästa
 * fråga schemaläggs först när svaret har kommit, så två körs aldrig samtidigt.
 * Ett svar som en senare fråga redan har ersatt (null) schemalägger inget.
 * Returnerar en funktion som slutar fråga.
 */
export function keepSessionAlive(
  first: AuthStatus,
  check: () => Promise<AuthStatus | null>,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const checkAfter = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      check().then(next, () => checkAfter(RETRY_MS));
    }, delayMs);
  };
  const next = (status: AuthStatus | null) => {
    // Utan `refresh_in` finns ingen token att förnya.
    if (status?.authenticated && status.refresh_in !== undefined) {
      checkAfter((status.refresh_in + 1) * 1000);
    }
  };

  next(first);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
