/**
 * Names for a flow's `list` field (participants): typed one at a time, pasted
 * as a list, or picked from the names this user entered before. The recent
 * names stay in this browser's storage and are never sent anywhere.
 */

import type { KeyValueStorage } from "./flow-session";

const SEPARATORS = /[,;\n\r]+/;
const RECENT_MAX = 30;

/** "Anna Berg, Erik Lund;\nSara Holm" → three names, trimmed, empties dropped. */
export function splitNames(text: string): string[] {
  return text
    .split(SEPARATORS)
    .map((name) => name.trim())
    .filter(Boolean);
}

/** The complete names in typed text, and what follows the last separator. */
export function takeNames(text: string): { names: string[]; rest: string } {
  const parts = text.split(/[,;\n\r]/);
  const rest = parts.pop() ?? "";
  return { names: splitNames(parts.join(",")), rest };
}

/** Adds the names not already there, in order; "anna berg" is "Anna Berg". */
export function addNames(current: readonly string[], names: readonly string[]): string[] {
  const next = [...current];
  for (const name of names) {
    if (!next.some((existing) => existing.toLowerCase() === name.toLowerCase())) next.push(name);
  }
  return next;
}

const recentKey = (ownerId: string) => `tal-till-text:${ownerId}:recent-names`;

/** The names this user entered before, most recent first. */
export function recentNames(storage: KeyValueStorage | null | undefined, ownerId: string): string[] {
  try {
    const saved: unknown = JSON.parse(storage?.getItem(recentKey(ownerId)) ?? "[]");
    return Array.isArray(saved) ? saved.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}

export function rememberNames(
  storage: KeyValueStorage | null | undefined,
  ownerId: string,
  names: readonly string[],
): void {
  const recent = addNames([...names].reverse(), recentNames(storage, ownerId)).slice(0, RECENT_MAX);
  try {
    storage?.setItem(recentKey(ownerId), JSON.stringify(recent));
  } catch {
    // Full or blocked storage: the suggestions are a convenience.
  }
}
