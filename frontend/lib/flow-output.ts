import type { RunContract } from "./api";

/**
 * Whether the flow's result is text rather than a document: exactly when Eneo gives it back in the run (delivery
 * "payload"), which the result view shows. A file, a result sent on to a receiver, and an Eneo or flow that does not
 * say are a document, as they always were.
 */
export function makesText(output: Pick<NonNullable<RunContract["final_output"]>, "delivery"> | null | undefined): boolean {
  return output?.delivery === "payload";
}

/** The action that makes the run, by what the flow ends in (`makesText`). */
export function createActionLabel(text: boolean): string {
  return text ? "Skapa text" : "Skapa dokument";
}
