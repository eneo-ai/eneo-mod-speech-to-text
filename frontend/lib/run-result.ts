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

/**
 * Whether a run makes text rather than a document: its own version's contract delivers the final output as a
 * payload (Eneo's `final_output.delivery`, from flow_run_contract_service `_output_delivery`), which this view shows
 * as text. A file, an output sent on elsewhere, a delivery Eneo does not state or a run of an older version (today's
 * contract says nothing of it) reads as a document, as it always did. The setup's makesText asks the same of the
 * contract; the two fold into one.
 */
export function runMakesText(
  run: { flow_version?: number | null },
  contract: Pick<RunContract, "published_flow_version" | "final_output"> | null | undefined,
): boolean {
  return ofContractVersion(run, contract) && contract?.final_output?.delivery === "payload";
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
