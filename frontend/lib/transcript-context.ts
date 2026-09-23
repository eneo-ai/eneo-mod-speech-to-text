import {
  getRunArtifactText,
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
  /** The text shown is the start of a longer transcript whose whole could not be read. */
  textPreview: boolean;
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
  textPreview: false,
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

/** The step's transcript as text, and its file when what is inline is only the start of it. */
interface TranscriptText {
  text: string;
  /** The file with the whole text, when `text` is a preview of it. */
  fileId: string | null;
  fullBytes: number | null;
}

/**
 * The step's verbatim transcript as text: its runtime input's transcription,
 * whatever the step then made of it, else the output of a step that only
 * transcribed. A model-backed step's output is its completion, never the
 * transcript, so without the input it gives no text.
 */
function transcriptText(step: FlowRunStep | undefined): TranscriptText | null {
  const input = step?.input_payload_json as { runtime_input?: { text?: unknown } } | null | undefined;
  const runtime = input?.runtime_input?.text;
  if (typeof runtime === "string") return { text: runtime, fileId: null, fullBytes: null };
  const reference = runtime as { kind?: unknown; preview?: unknown; file_id?: unknown; full_text_bytes?: unknown } | undefined;
  if (reference?.kind === "file_backed_step_text" && typeof reference.preview === "string" && typeof reference.file_id === "string") {
    return {
      text: reference.preview,
      fileId: reference.file_id,
      fullBytes: typeof reference.full_text_bytes === "number" ? reference.full_text_bytes : null,
    };
  }
  const mode = (step?.model_parameters_json as { mode?: unknown } | null | undefined)?.mode;
  const output = step?.output_payload_json as
    | { text?: unknown; text_overflow?: { generated_file_ids?: unknown; full_text_bytes?: unknown } }
    | null
    | undefined;
  if (mode !== "transcribe_only" || typeof output?.text !== "string") return null;
  const overflow = output.text_overflow;
  const fileId = Array.isArray(overflow?.generated_file_ids) ? overflow.generated_file_ids[0] : undefined;
  return typeof fileId === "string"
    ? { text: output.text, fileId, fullBytes: typeof overflow?.full_text_bytes === "number" ? overflow.full_text_bytes : null }
    : { text: output.text, fileId: null, fullBytes: null };
}

/** The whole text of a preview from its file, checked against the size Eneo recorded; the preview when that fails. */
async function wholeText(flowId: string, runId: string, text: TranscriptText): Promise<TranscriptText> {
  if (!text.fileId) return text;
  try {
    const whole = await getRunArtifactText(flowId, runId, text.fileId);
    if (text.fullBytes === null || new TextEncoder().encode(whole).length === text.fullBytes) {
      return { text: whole, fileId: null, fullBytes: null };
    }
  } catch {
    // The preview stays, marked as one.
  }
  return text;
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
  let stepText: TranscriptText | null = null;
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
    // Taken before the source is read, so the text is there to show even when that read fails.
    stepText = transcriptText(step);
    const transcription = await withSourceSegments(flowId, runId, step);
    segments = segmentsFromTranscription(transcription);
    // Without segments the text is the transcript; a preview is read in full first.
    if (segments === null && stepText) stepText = await wholeText(flowId, runId, stepText);
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
  const displaySegments = segments ?? parseTranscriptText(fallbackText ?? stepText?.text ?? "", labelFor);
  // Text names a block's recording only with "## Del N"; with several recordings and no such
  // names, the text stays readable but nothing seeks, since it could land in the wrong one.
  const seekable =
    fromMetadata ||
    (displaySegments.every((segment) => segment.fileIndex < Math.max(1, fileIds.length)) &&
      (fileIds.length <= 1 || /^## Del \d+/m.test(fallbackText ?? stepText?.text ?? "")));
  if (!seekable) fileIds = [];
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
    textPreview: !fromMetadata && fallbackText === undefined && Boolean(stepText?.fileId),
  };
}
