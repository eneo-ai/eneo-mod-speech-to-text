import type { FlowRunError, FlowRunResult, RunContract } from "./api";
import { ofContractVersion } from "./run-progress";

export interface RunResultView {
  /** Markdown att visa, eller null när resultatet inte är text. */
  text: string | null;
  /** Kort förklaring som visas före resultatet. */
  note: string | null;
}

/** Vad resultatvyn visar för Eneos typade slutresultat (`run.result`). */
export function runResultView(
  result: FlowRunResult | null | undefined,
): RunResultView {
  switch (result?.kind) {
    case "inline_text":
      return { text: result.text, note: null };
    case "file_backed_text":
      // `preview` är bara början; hela texten finns i en fil i result_files.
      return {
        text: result.preview,
        note:
          result.file.availability === "content_purged"
            ? "Texten är för lång för att visas i sin helhet, så här visas bara början. Hela texten har tagits bort och går inte längre att hämta."
            : "Texten är för lång för att visas i sin helhet, så här visas bara början. Hela texten finns i filen under Filer.",
      };
    case "structured":
      return {
        text:
          typeof result.value === "string"
            ? result.value
            : "```json\n" + JSON.stringify(result.value, null, 2) + "\n```",
        note: null,
      };
    case "outbound_http":
      return {
        text: null,
        note: "Resultatet skickades vidare till mottagaren som är inställd i flödet.",
      };
    default:
      // Artefakter listas under Filer.
      return { text: null, note: null };
  }
}

/** Eneo delivers the final output as a payload, text in the run (the setup's makesText: the one delivery rule). */
function makesText(output: Pick<NonNullable<RunContract["final_output"]>, "delivery"> | null | undefined): boolean {
  return output?.delivery === "payload";
}

/** What a run makes: text (JSON shown as text), a document, or null where neither can be said. */
export type RunOutput = "text" | "document" | null;

/**
 * What a run makes, for its page's words. A finished run says so in its own result, whatever version it ran:
 * text (inline, file-backed or structured) or a file. A run without one (failed, cancelled) is read from the
 * contract, only of its own version and only as it states the delivery (`makesText`). Null, neutral words, where
 * neither says: an output sent on, another version, a delivery not stated.
 */
export function runOutput(
  run: { flow_version?: number | null; result?: FlowRunResult | null },
  contract: Pick<RunContract, "published_flow_version" | "final_output"> | null | undefined,
): RunOutput {
  switch (run.result?.kind) {
    case "inline_text":
    case "file_backed_text":
    case "structured":
      return "text";
    case "artifact":
      return "document";
    case "outbound_http":
      return null;
  }
  if (!ofContractVersion(run, contract)) return null;
  return makesText(contract?.final_output) ? "text" : contract?.final_output?.delivery === "artifact" ? "document" : null;
}

/** The words for what a run makes: "texten", "dokumentet" or, neutral, "resultatet"; its tab and its two headings. */
export function outputWords(output: RunOutput) {
  const [thing, tab, gender] =
    output === "text" ? ["texten", "Text", "klar"] : output === "document" ? ["dokumentet", "Dokument", "klart"] : ["resultatet", "Resultat", "klart"];
  const named = thing[0].toUpperCase() + thing.slice(1);
  return { thing, named, tab, ready: `${named} är ${gender}`, failed: `${named} kunde inte skapas` };
}

/** The files Eneo names as the run's result (the final step's, or the whole text's), apart from every other run file. */
export function resultFileIds(result: FlowRunResult | null | undefined): string[] {
  if (result?.kind === "artifact") return result.files.map((file) => file.file_id);
  if (result?.kind === "file_backed_text") return [result.file.file_id];
  return [];
}

const CANCELLED = "Körningen avbröts innan den blev klar.";
const TOO_LARGE = "Inspelningen eller filen är större än flödet klarar.";
// Eneo's audio ceilings (a duration, or the decoded bytes it stands for) both measure how long the audio is.
const TOO_LONG = "Inspelningen eller filen är längre än flödet klarar.";
const SERVICE_UNAVAILABLE = "Tjänsten svarade inte eller var överbelastad.";
const STOPPED = "Körningen tog för lång tid eller slutade svara och avbröts.";

// Vad som hände, för Eneos slutfelskoder som användaren av modulen kan förstå.
// Råd om att köra igen står inte här: det följer bara `retryable`.
const RUN_ERROR_EXPLANATIONS: Record<string, string> = {
  flow_run_cancelled: CANCELLED,
  flow_run_user_cancelled: CANCELLED,
  flow_review_rejected:
    "Resultatet avvisades i granskningen och körningen avslutades.",
  flow_review_expired:
    "Tiden för granskningen har gått ut och körningen har avbrutits.",
  flow_run_abandoned:
    "Körningen väntade för länge på att fortsätta och avslutades.",
  typed_io_transcription_failed: "Transkriberingen av ljudet misslyckades.",
  typed_io_transcription_empty: "Transkriberingen gav ingen text.",
  typed_io_empty_extraction: "Ingen text kunde läsas ur filen.",
  typed_io_audio_exceeds_limit: TOO_LONG,
  typed_io_transcript_too_large: TOO_LARGE,
  typed_io_input_too_large: TOO_LARGE,
  typed_io_input_exceeds_model_window: TOO_LARGE,
  flow_provider_rate_limited: SERVICE_UNAVAILABLE,
  flow_provider_unavailable: SERVICE_UNAVAILABLE,
  typed_io_transcription_model_unavailable: SERVICE_UNAVAILABLE,
  flow_worker_stalled: STOPPED,
  flow_task_timeout: STOPPED,
  flow_step_timeout: STOPPED,
  flow_llm_request_timeout: STOPPED,
};

// Hur indata kan ändras när flödet inte kunde använda den. Det säger inget om
// att köra igen: arbete kan redan ha gjorts, så det rådet följer `retryable`.
const SHORTER_PARTS = "Dela upp inspelningen eller filen i kortare delar.";
const INPUT_HINTS: Record<string, string> = {
  typed_io_transcription_empty: "Inspelningen kan sakna tal.",
  typed_io_empty_extraction: "Filen behöver innehålla läsbar text.",
  typed_io_audio_exceeds_limit: SHORTER_PARTS,
  typed_io_transcript_too_large: SHORTER_PARTS,
  typed_io_input_too_large: SHORTER_PARTS,
  typed_io_input_exceeds_model_window: SHORTER_PARTS,
};

// Eneo sätter `retryable` bara när inget arbete hann tas emot och inget
// hände utanför Eneo; annars kan en ny körning göra om arbete som redan gjorts.
const RETRY_ADVICE = "Det går bra att köra flödet igen om en stund.";
const CHECK_FIRST_ADVICE =
  "Kontrollera vad som hann göras innan du kör flödet igen, eller kontakta support med körnings-ID.";

export interface RunErrorView {
  /** Vad som hände och ev. hur indata kan ändras, valt utifrån `code`; råd om att köra igen utifrån `retryable`. */
  summary: string;
  /** "Steg 2, Sammanfattning" när felet hör till ett steg. */
  step: string | null;
  /** Eneos tekniska beskrivning. Visas som detalj, tolkas aldrig. */
  detail: string;
  /** Flödet kunde inte använda indata, så en ny körning med samma ljud hjälper inte. */
  inputMustChange: boolean;
}

/** Vad resultatvyn visar för Eneos typade slutfel (`run.error`); stegens namn efter deras ordning. */
export function runErrorView(
  error: FlowRunError,
  stepLabels: Record<number, string> = {},
): RunErrorView {
  const explanation =
    RUN_ERROR_EXPLANATIONS[error.code] ?? "Körningen kunde inte slutföras.";
  const summary = [
    explanation,
    INPUT_HINTS[error.code],
    error.retryable ? RETRY_ADVICE : CHECK_FIRST_ADVICE,
  ]
    .filter(Boolean)
    .join(" ");
  const stepName =
    error.details?.step_description ??
    (error.step_order ? stepLabels[error.step_order] : undefined);
  const step = error.step_order
    ? [`Steg ${error.step_order}`, stepName].filter(Boolean).join(", ")
    : null;
  return { summary, step, detail: error.message, inputMustChange: error.code in INPUT_HINTS };
}
