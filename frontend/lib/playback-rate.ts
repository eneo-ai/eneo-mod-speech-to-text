/**
 * The one owner of the transcript player's speeds, and of the speed a person last chose in this browser: the next
 * transcript they play starts at it. Only a speed the player offers is kept or read back.
 */

import type { KeyValueStorage } from "./browser-storage";

/** The speeds the player offers. */
export const RATES = [0.75, 1, 1.25, 1.5, 2];

const key = (ownerId: string) => `tal-till-text:${ownerId}:playback-rate`;

/** The speed this person last chose, or 1 when they have chosen none the player offers. */
export function playbackRate(storage: KeyValueStorage | null | undefined, ownerId: string): number {
  try {
    const rate = Number(storage?.getItem(key(ownerId)));
    return RATES.includes(rate) ? rate : 1;
  } catch {
    return 1;
  }
}

export function setPlaybackRate(storage: KeyValueStorage | null | undefined, ownerId: string, rate: number): void {
  if (!RATES.includes(rate)) return;
  try {
    storage?.setItem(key(ownerId), String(rate));
  } catch {
    // Full or blocked storage: the speed holds while the page is open.
  }
}
