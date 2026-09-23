import {
  getRunSteps,
  getTranscriptSource,
  getTranscriptWords,
  listTranscriptCorrections,
  type FlowRunStep,
} from "./api";
import {
  carriesTranscript,
  speakerReviewsFromTranscription,
  stepTranscription,
  stepTranscriptText,
  type FileSpeakerReview,
} from "./speaker-review";
import {
  attachWords,
  fileIdsFromTranscription,
  needsSpeakerReview,
  parseTranscriptText,
  segmentsFromTranscription,
  type TranscriptSegment,
} from "./transcript";
import {
  EMPTY_CORRECTIONS,
  correctionsFromResponse,
  correctionWriteProblem,
  type CorrectionSet,
} from "./transcript-corrections";

export interface TranscriptContext {
  speakerReviews: FileSpeakerReview[];
  correctionProblem: string | null;
  pending: boolean;
  /** Råa segment (etiketter SPEAKER_NN, okorrigerad text). */
  segments: TranscriptSegment[];
  /** Segmenten kom från stegets lagrade metadata (krävs för korrigeringar). */
  fromMetadata: boolean;
  fileIds: string[];
  stepId: string | null;
  /** Sparade korrigeringar för steget, eller tomt set. */
  corrections: CorrectionSet;
  /** Namn per etikett som ett speaker-mapping-steg i körningen redan valt. */
  speakerNames: Record<string, string>;
}

export const INITIAL_TRANSCRIPT: TranscriptContext = {
  pending: true,
  speakerReviews: [],
  correctionProblem: null,
  segments: [],
  fromMetadata: false,
  fileIds: [],
  stepId: null,
  corrections: EMPTY_CORRECTIONS,
  speakerNames: {},
};

/** Namn ur ett speaker-mapping-stegs output (`structured.speakers`). */
function speakerNamesFromSteps(steps: readonly FlowRunStep[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const step of steps) {
    const output = step.output_payload_json as
      | { structured?: { speakers?: unknown } }
      | null
      | undefined;
    const speakers = output?.structured?.speakers;
    if (!Array.isArray(speakers)) continue;
    for (const item of speakers) {
      const entry = item as { label?: unknown; name?: unknown };
      if (
        typeof entry?.label === "string" &&
        typeof entry.name === "string" &&
        entry.name.trim()
      ) {
        names[entry.label] = entry.name.trim();
      }
    }
  }
  return names;
}

// ponytail: 200 pages of 200 segments bound a read at 40 000 segments (days of audio); a longer one fails loudly.
const MAX_SOURCE_PAGES = 200;

/**
 * The step's transcription with its segments where the rest of the module
 * reads them. Eneo keeps an attempt's segments in its transcript source,
 * paged; a step stored by an older Eneo has them inline. When Eneo kept none,
 * the transcription stays without segments and the step's text is shown.
 */
async function withSourceSegments(flowId: string, runId: string, step: FlowRunStep | undefined): Promise<unknown> {
  const transcription = stepTranscription(step);
  const meta = transcription as { segments?: unknown; source?: unknown } | null | undefined;
  const source = meta?.source as { attempt_no?: unknown; bounds?: { segments_omitted_reason?: unknown } } | undefined;
  if (!step?.step_id || !meta || Array.isArray(meta.segments) || typeof source?.attempt_no !== "number") return transcription;
  if (source.bounds?.segments_omitted_reason != null) return transcription;
  const segments: Record<string, unknown>[] = [];
  let speakerReview: unknown = null;
  let sourceHash: string | null = null;
  for (let start: number | null = 0, page = 0; start !== null; page += 1) {
    if (page === MAX_SOURCE_PAGES) throw new Error("The transcript source has more pages than the module reads.");
    const read = await getTranscriptSource(flowId, runId, step.step_id, source.attempt_no, start);
    if (read.status !== "present") return transcription;
    if (start === 0) speakerReview = read.speaker_review ?? null;
    sourceHash = read.source_hash;
    segments.push(...read.segments);
    start = read.next_segment_index;
  }
  return { ...meta, segments, speaker_review: speakerReview, segments_hash: sourceHash };
}

/**
 * Hämtar allt spelaren behöver för en körning: transkriberingsstegets
 * segment och ljudfiler, ordtider (404 = inga), sparade korrigeringar och
 * eventuella namn från ett speaker-mapping-steg. Avvisar aldrig: ett fel
 * blir `correctionProblem` och texten visas som den är.
 *
 * `source` pekar ut transkriberingssteget (från checkpointens
 * `speaker_mapping.source_step_*`); saknas det väljs första steget med
 * transkriptionsmetadata. `fallbackText` parsas om steget saknar segment.
 */
export async function loadTranscriptContext({
  flowId,
  runId,
  steps: providedSteps,
  source,
  fallbackText,
  labelFor,
}: {
  flowId: string;
  runId: string;
  steps?: readonly FlowRunStep[];
  source?: { stepId: string | null; stepOrder: number | null };
  fallbackText?: string;
  labelFor?: (speaker: string) => string;
}): Promise<TranscriptContext> {
  let segments: TranscriptSegment[] | null = null;
  let speakerReviews: FileSpeakerReview[] = [];
  let correctionProblem: string | null = null;
  let fileIds: string[] = [];
  let stepId: string | null = null;
  let corrections: CorrectionSet = EMPTY_CORRECTIONS;
  let speakerNames: Record<string, string> = {};
  let stepText: string | null = null;
  try {
    const steps =
      providedSteps && providedSteps.length > 0
        ? providedSteps
        : await getRunSteps(flowId, runId);
    const step =
      (source?.stepId
        ? steps.find((st) => st.step_id === source.stepId)
        : undefined) ??
      (source?.stepOrder != null
        ? steps.find((st) => st.step_order === source.stepOrder)
        : undefined) ??
      steps.find(carriesTranscript);
    stepText = stepTranscriptText(step);
    const transcription = await withSourceSegments(flowId, runId, step);
    segments = segmentsFromTranscription(transcription);
    const hash = (transcription as { segments_hash?: unknown } | null)?.segments_hash;
    const segmentsHash = typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash) ? hash : null;
    corrections = { ...EMPTY_CORRECTIONS, ...(segmentsHash ? { schemaVersion: 3, segmentsHash } : {}) };
    speakerReviews = speakerReviewsFromTranscription(transcription);
    fileIds = fileIdsFromTranscription(transcription);
    if (fileIds.length === 0 && Array.isArray(step?.runtime_input_file_ids)) {
      fileIds = (step.runtime_input_file_ids as unknown[]).filter(
        (id): id is string => typeof id === "string",
      );
    }
    stepId = step?.step_id ?? null;
    speakerNames = speakerNamesFromSteps(steps);
    if (segments && stepId) {
      const [words, sets] = await Promise.all([
        // 404 är normalt: steget lagrade inga ordtider.
        getTranscriptWords(flowId, runId, stepId).catch(() => null),
        listTranscriptCorrections(flowId, runId).catch(() => {
          correctionProblem = "Kunde inte läsa sparade rättningar. Läs in sidan igen innan du redigerar eller godkänner.";
          return [];
        }),
      ]);
      segments = attachWords(segments, words);
      const own = sets.find((set) => set.step_id === stepId);
      if (own) {
        try {
          corrections = correctionsFromResponse(own, segments, segmentsHash);
          if (segmentsHash) corrections = { ...corrections, schemaVersion: 3, segmentsHash };
          correctionProblem = correctionWriteProblem(corrections);
        } catch (error) {
          correctionProblem = error instanceof Error ? error.message : "Rättningarna kunde inte läsas.";
        }
      }
    }
  } catch {
    correctionProblem = "Kunde inte läsa transkriptets underlag. Läs in sidan igen innan du godkänner.";
    // Utan stegdata visas texten som den är, utan ljud.
  }
  const fromMetadata = segments !== null;
  // Without segments the text is the transcript: the checkpoint's when reviewing, else the step's own.
  const displaySegments = segments ?? parseTranscriptText(fallbackText ?? stepText ?? "", labelFor);
  if (!correctionProblem && corrections.schemaVersion !== 3 && (speakerReviews.length > 0 || displaySegments.some(needsSpeakerReview))) {
    correctionProblem = "Talargranskningen visas skrivskyddat. Transkriptets originalunderlag saknas för sparande och godkännande.";
  }
  return {
    pending: false,
    speakerReviews,
    correctionProblem,
    segments: displaySegments,
    fromMetadata,
    fileIds,
    stepId,
    corrections,
    speakerNames,
  };
}
