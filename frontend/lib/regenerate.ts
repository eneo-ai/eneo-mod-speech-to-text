/**
 * "Skapa dokumentet igen": when the transcript's saved
 * corrections are newer than the document, a new run can make the document
 * again from the reviewed transcript. The source run and its files never
 * change; nothing happens unless the user asks.
 */

import { ApiError, regenerateTranscript, type FlowRunPublic, type FlowRunStep, type TranscriptCorrectionsPublic } from "./api";
import { friendlyError, refusalReason } from "./errors";
import { carriesTranscript } from "./speaker-review";
import { isSegmentsHash, type CorrectionSet } from "./transcript-corrections";

export interface RegenerationRequest {
  flowId: string;
  runId: string;
  stepId: string;
  runRevision: number;
  correctionRevision: number;
  segmentsHash: string;
}

/** The saved corrections of the run's transcript, as read with the finished run. */
export function savedTranscriptCorrections(
  steps: readonly FlowRunStep[],
  saved: readonly TranscriptCorrectionsPublic[] | null | undefined,
): TranscriptCorrectionsPublic | undefined {
  const stepId = steps.find(carriesTranscript)?.step_id;
  return stepId ? saved?.find((candidate) => candidate.step_id === stepId) : undefined;
}

/**
 * Whether the transcript's saved corrections, as read with the finished run, are newer than its document: known before
 * the transcript itself is read, so the page gives the offer its place from the first draw (RunResult). Whether a new
 * document can be made from them is regenerationOffer's to say, once the transcript is read.
 */
export function correctionsNewerThanDocument(
  run: Pick<FlowRunPublic, "finished_at">,
  steps: readonly FlowRunStep[],
  saved: readonly TranscriptCorrectionsPublic[] | null | undefined,
): boolean {
  const set = savedTranscriptCorrections(steps, saved);
  if (!set?.updated_at || !run.finished_at) return false;
  return Date.parse(set.updated_at) > Date.parse(run.finished_at);
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
  if (corrections.schemaVersion !== 3 || !isSegmentsHash(corrections.segmentsHash)) return null;
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

/**
 * The saved corrections only give speakers names: the text and who says what are as the document has them, so the
 * notice says the names are what the new document adds. Read in Eneo's shape (with the run) or the page's.
 */
export function namesOnly(set: {
  occurrences: readonly unknown[];
  speaker_edits: readonly unknown[];
  speaker_names?: Readonly<Record<string, unknown>>;
  speakerNames?: Readonly<Record<string, unknown>>;
}): boolean {
  const names = set.speakerNames ?? set.speaker_names ?? {};
  return set.occurrences.length === 0 && set.speaker_edits.length === 0 && Object.keys(names).length > 0;
}

type RegenerationOutcome =
  | { kind: "started"; run: FlowRunPublic }
  | { kind: "refused"; message: string; reload: boolean };

/** Starts the new run. The key names the run and the corrections it is made from, so asking twice gives the same run. */
export async function regenerate(offer: RegenerationRequest, thing = "dokumentet"): Promise<RegenerationOutcome> {
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
    return { kind: "refused", ...regenerationRefusal(err, thing) };
  }
}

/**
 * Eneo's refusals in words for this action, about what the flow makes ("dokumentet" or "texten"); `reload` when
 * reading the page again is the way on.
 */
export function regenerationRefusal(err: unknown, thing = "dokumentet"): { message: string; reload: boolean } {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "flow_transcript_corrections_stale_revision":
      case "flow_run_idempotency_conflict":
        return {
          message: "Transkriberingen eller rättningarna har ändrats sedan sidan lästes in. Läs in igen och försök sedan.",
          reload: true,
        };
      case "flow_run_stale_version":
        return {
          message:
            `Flödet har ändrats sedan ${thing} skapades, så ${thing} kan inte skapas igen på samma sätt. Ladda ner den rättade transkriberingen i stället.`,
          reload: false,
        };
      case "flow_transcript_corrections_invalid_occurrence":
        return {
          message:
            refusalReason(err) === "file_backed_prefix_unsupported"
              ? `Transkriberingen är för lång för att ${thing} ska kunna skapas igen här. Ladda ner den rättade transkriberingen i stället.`
              : `Det här flödet kan inte skapa ${thing} igen från en rättad transkribering. Ladda ner den rättade transkriberingen i stället.`,
          reload: false,
        };
      case "flow_run_input_payload_too_large":
        return {
          message: `Den rättade transkriberingen är större än flödet tar emot, så ${thing} kan inte skapas igen här. Ladda ner den rättade transkriberingen i stället.`,
          reload: false,
        };
      case "flow_run_access_denied":
        return { message: `Du har inte behörighet att skapa ${thing} igen för den här körningen.`, reload: false };
    }
  }
  return { message: friendlyError(err), reload: false };
}
