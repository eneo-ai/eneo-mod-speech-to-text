"use client";

import { useCallback, useEffect, useState } from "react";
import {
  readConfirmedWords,
  toggleConfirmed,
  writeConfirmedWords,
} from "@/lib/confirmed-words";

const EMPTY: ReadonlySet<string> = new Set();

/**
 * The uncertain words a reviewer has confirmed for a transcription step, kept on this device. `storageKey` is null
 * before the step is known: the set is then empty and a toggle is ignored.
 */
export function useConfirmedWords(
  storageKey: string | null,
): [ReadonlySet<string>, (key: string) => void] {
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(EMPTY);

  useEffect(() => {
    if (!storageKey) {
      setConfirmed(EMPTY);
      return;
    }
    setConfirmed(readConfirmedWords(window.localStorage, storageKey));
  }, [storageKey]);

  const toggle = useCallback(
    (key: string) => {
      if (!storageKey) return;
      setConfirmed((prev) => {
        const next = toggleConfirmed(prev, key);
        writeConfirmedWords(window.localStorage, storageKey, next);
        return next;
      });
    },
    [storageKey],
  );

  return [confirmed, toggle];
}
