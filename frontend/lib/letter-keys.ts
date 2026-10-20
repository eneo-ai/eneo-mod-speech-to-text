/**
 * The one owner of whether the transcript player's letter keys (K plays and pauses, J and L skip) act for a person in
 * this browser. They are on until the person turns them off on the player's line of keys: a letter that speech input
 * types at the page, or one pressed by mistake, then does nothing (WCAG 2.1.4). The choice stays in this browser.
 */

import type { KeyValueStorage } from "./browser-storage";

const key = (ownerId: string) => `tal-till-text:${ownerId}:letter-keys`;

/** Whether K, J and L act for this person: on, unless they turned them off. */
export function letterKeysOn(storage: KeyValueStorage | null | undefined, ownerId: string): boolean {
  try {
    return storage?.getItem(key(ownerId)) !== "off";
  } catch {
    return true;
  }
}

export function setLetterKeysOn(storage: KeyValueStorage | null | undefined, ownerId: string, on: boolean): void {
  try {
    storage?.setItem(key(ownerId), on ? "on" : "off");
  } catch {
    // Full or blocked storage: the choice holds while the page is open.
  }
}
