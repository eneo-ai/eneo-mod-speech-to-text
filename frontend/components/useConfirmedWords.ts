"use client";

import { useCallback, useEffect, useState } from "react";
import {
  readConfirmedWords,
  toggleConfirmed,
  writeConfirmedWords,
} from "@/lib/confirmed-words";

const EMPTY: ReadonlySet<string> = new Set();

/**
 * Lokalt lagrade bekräftelser av osäkra ord för ett transkriberingssteg.
 * `storageKey` = null innan steget är känt; då är mängden tom och
 * växlingar ignoreras.
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
