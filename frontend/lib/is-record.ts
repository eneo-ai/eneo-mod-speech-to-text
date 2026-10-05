/** An object that is neither a list nor null: the first thing a reader of untyped JSON checks. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
