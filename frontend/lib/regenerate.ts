/**
 * "Skapa dokumentet igen med rättningarna": when the transcript's saved
 * corrections are newer than the document, a new run can make the document
 * again from the reviewed transcript. The source run and its files never
 * change; nothing happens unless the user asks.
 */

import { ApiError, regenerateTranscript, type FlowRunPublic } from "./api";
import { friendlyError } from "./errors";
import type { CorrectionSet } from "./transcript-corrections";

export interface RegenerationRequest {
  flowId: string;
  runId: string;
  stepId: string;
  runRevision: number;
  correctionRevision: number;
  segmentsHash: string;
}

/**
 * The request a new document would be made with, or null when it cannot or
 * need not be: no document, no stored segments (a text-only transcript, whose
 * corrections cannot be saved either), no saved corrections, or corrections
 * no newer than the document.
 */
export function regenerationOffer({
  flowId,
  run,
  stepId,
  fromMetadata,
  corrections,
  hasDocument,
}: {
  flowId: string;
  run: FlowRunPublic;
  stepId: string | null;
  fromMetadata: boolean;
  corrections: CorrectionSet;
  hasDocument: boolean;
}): RegenerationRequest | null {
  if (!hasDocument || !fromMetadata || !stepId || typeof run.revision !== "number") return null;
  if (corrections.schemaVersion !== 3 || !/^[0-9a-f]{64}$/.test(corrections.segmentsHash ?? "")) return null;
  if (corrections.revision === null || !corrections.updatedAt || !run.finished_at) return null;
  if (Date.parse(corrections.updatedAt) <= Date.parse(run.finished_at)) return null;
  return {
    flowId,
    runId: run.id,
    stepId,
    runRevision: run.revision,
    correctionRevision: corrections.revision,
    segmentsHash: corrections.segmentsHash!,
  };
}

export type RegenerationOutcome =
  | { kind: "started"; run: FlowRunPublic }
  | { kind: "refused"; message: string; reload: boolean };

/** Starts the new run. The key names the run and the corrections it is made from, so asking twice gives the same run. */
export async function regenerate(offer: RegenerationRequest): Promise<RegenerationOutcome> {
  try {
    const { run } = await regenerateTranscript(
      offer.flowId,
      offer.runId,
      offer.stepId,
      {
        expected_run_revision: offer.runRevision,
        expected_correction_revision: offer.correctionRevision,
        segments_hash: offer.segmentsHash,
      },
      `transcript-regeneration:${offer.runId}:${offer.correctionRevision}`,
    );
    return { kind: "started", run };
  } catch (err) {
    return { kind: "refused", ...regenerationRefusal(err) };
  }
}

/** Eneo's refusals in words for this action; `reload` when reading the page again is the way on. */
export function regenerationRefusal(err: unknown): { message: string; reload: boolean } {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "flow_transcript_corrections_stale_revision":
      case "flow_run_idempotency_conflict":
        return {
          message: "Transkriptet eller rättningarna har ändrats sedan sidan lästes in. Läs in igen och försök sedan.",
          reload: true,
        };
      case "flow_run_stale_version":
        return {
          message:
            "Flödet har ändrats sedan dokumentet skapades, så dokumentet kan inte skapas igen på samma sätt. Ladda ner det rättade transkriptet i stället.",
          reload: false,
        };
      case "flow_transcript_corrections_invalid_occurrence":
        return {
          message:
            "Det här flödet kan inte skapa dokumentet igen från ett rättat transkript. Ladda ner det rättade transkriptet i stället.",
          reload: false,
        };
      case "flow_run_access_denied":
        return { message: "Du har inte behörighet att skapa dokumentet igen för den här körningen.", reload: false };
    }
  }
  return { message: friendlyError(err), reload: false };
}
