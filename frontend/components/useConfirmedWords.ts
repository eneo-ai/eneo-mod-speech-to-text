import { useCallback, useEffect, useRef, useState } from "react";
import { browserStorage } from "@/lib/browser-storage";
import { readConfirmedWords, toggleConfirmed, writeConfirmedWords } from "@/lib/confirmed-words";

const EMPTY: ReadonlySet<string> = new Set();

/**
 * The confirmations of uncertain words kept in this browser for a transcription step. `storageKey` is null until the
 * step is known: the set is then empty and a toggle is ignored.
 */
export function useConfirmedWords(storageKey: string | null): [ReadonlySet<string>, (key: string) => void] {
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(EMPTY);
  const current = useRef(EMPTY);

  useEffect(() => {
    current.current = storageKey ? readConfirmedWords(browserStorage(), storageKey) : EMPTY;
    setConfirmed(current.current);
  }, [storageKey]);

  const toggle = useCallback(
    (key: string) => {
      if (!storageKey) return;
      current.current = toggleConfirmed(current.current, key);
      setConfirmed(current.current);
      writeConfirmedWords(browserStorage(), storageKey, current.current);
    },
    [storageKey],
  );

  return [confirmed, toggle];
}
