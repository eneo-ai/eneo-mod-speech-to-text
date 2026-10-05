export type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

/** The browser's localStorage, or null where the page may not use it. */
export function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
