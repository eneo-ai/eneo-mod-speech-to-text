/**
 * Names for a flow's `list` field (participants): typed one at a time, pasted
 * as a list, or picked from the names this user entered before. The recent
 * names stay in this browser's storage and are never sent anywhere.
 */

import type { KeyValueStorage } from "./browser-storage";

const SEPARATOR = /[,;\n\r]/;
const RECENT_MAX = 30;

/** Whether `text` holds a separator, so it is a list and not one name. */
export const hasSeparator = (text: string): boolean => SEPARATOR.test(text);

/** "Anna Berg, Erik Lund;\nSara Holm" → three names, trimmed, empties dropped. */
export function splitNames(text: string): string[] {
  return text
    .split(new RegExp(`${SEPARATOR.source}+`))
    .map((name) => name.trim())
    .filter(Boolean);
}

/** The names a run was started with in its participants field: a list of names, or text with separators. */
export function participantsOf(value: unknown): string[] {
  if (typeof value === "string") return splitNames(value);
  if (!Array.isArray(value)) return [];
  return value.flatMap((name) => (typeof name === "string" && name.trim() ? [name.trim()] : []));
}

/** The complete names in typed text, and what follows the last separator. */
export function takeNames(text: string): { names: string[]; rest: string } {
  const parts = text.split(SEPARATOR);
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
// A person's names under either key: `tal-till-text:<owner>:recent-names` and `tal-till-text:<owner>:last-names:...`.
const NAMES_KEY = /^tal-till-text:([^:]+):(?:recent-names$|last-names:)/;

/**
 * Someone signed in here: every other person's names go (a shared computer), as their drafts and confirmed words do.
 * The signed-in person's stay.
 */
export function keepOnlyNamesOf(storage: Pick<Storage, "key" | "length" | "removeItem"> | null | undefined, ownerId: string): void {
  try {
    if (!storage) return;
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const name = storage.key(index);
      const owner = name ? NAMES_KEY.exec(name)?.[1] : undefined;
      if (name && owner && owner !== ownerId) storage.removeItem(name);
    }
  } catch {
    // A refused storage holds nothing.
  }
}

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

const lastNamesKey = (ownerId: string, flowId: string, field: string) => `tal-till-text:${ownerId}:last-names:${flowId}:${field}`;

/** The names this user last sent in a flow's list field, which its next setup offers to add in one press. */
export function lastNames(storage: KeyValueStorage | null | undefined, ownerId: string, flowId: string, field: string): string[] {
  try {
    const saved: unknown = JSON.parse(storage?.getItem(lastNamesKey(ownerId, flowId, field)) ?? "[]");
    return participantsOf(saved);
  } catch {
    return [];
  }
}

export function keepLastNames(
  storage: KeyValueStorage | null | undefined,
  ownerId: string,
  flowId: string,
  field: string,
  names: readonly string[],
): void {
  try {
    storage?.setItem(lastNamesKey(ownerId, flowId, field), JSON.stringify(names));
  } catch {
    // Full or blocked storage: the offer is a convenience.
  }
}
