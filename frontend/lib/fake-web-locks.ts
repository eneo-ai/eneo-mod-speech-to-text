// Test double for navigator.locks: exclusive locks per origin, held until the
// callback's promise settles, as the browser keeps them. The browser also
// ends a tab's locks when the tab closes or crashes.

export function fakeWebLocks(): Pick<LockManager, "request" | "query"> {
  const held = new Set<string>();
  return {
    async request(
      name: string,
      options: LockOptions | LockGrantedCallback,
      callback?: LockGrantedCallback,
    ) {
      const granted = (callback ?? options) as (lock: Lock | null) => unknown;
      const { ifAvailable = false } = callback ? (options as LockOptions) : {};
      if (held.has(name)) {
        if (ifAvailable) return granted(null);
        throw new Error("fakeWebLocks: waiting for a held lock is not modelled");
      }
      held.add(name);
      try {
        return await granted({ name, mode: "exclusive" } as Lock);
      } finally {
        held.delete(name);
      }
    },
    async query() {
      return { held: [...held].map((name) => ({ name, mode: "exclusive" as const })), pending: [] };
    },
  } as Pick<LockManager, "request" | "query">;
}
