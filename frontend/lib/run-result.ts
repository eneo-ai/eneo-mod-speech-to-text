import type { FlowRunError, FlowRunResult } from "./api";

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
            : "Texten är för lång för att visas i sin helhet, så här visas bara början. Hela texten finns i filen under Genererade filer.",
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
      // Artefakter listas under Genererade filer.
      return { text: null, note: null };
  }
}

const CANCELLED = "Körningen avbröts innan den blev klar.";
const TOO_LARGE = "Inspelningen eller filen är större än flödet klarar.";
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
  typed_io_transcription_empty:
    "Transkriberingen gav ingen text. Inspelningen kan sakna tal.",
  typed_io_empty_extraction: "Ingen text kunde läsas ur filen.",
  typed_io_audio_exceeds_limit: TOO_LARGE,
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

// Eneo sätter `retryable` bara när inget arbete hann tas emot och inget
// hände utanför Eneo; annars kan en ny körning göra om arbete som redan gjorts.
const RETRY_ADVICE = "Det går bra att köra flödet igen om en stund.";
const CHECK_FIRST_ADVICE =
  "Kontrollera vad som hann göras innan du kör flödet igen, eller kontakta support med körnings-ID.";

export interface RunErrorView {
  /** Vad som hände, valt utifrån `code`, och råd valt utifrån `retryable`. */
  summary: string;
  /** "Steg 2 · Sammanfattning" när felet hör till ett steg. */
  step: string | null;
  /** Eneos tekniska beskrivning. Visas som detalj, tolkas aldrig. */
  detail: string;
}

/** Vad resultatvyn visar för Eneos typade slutfel (`run.error`). */
export function runErrorView(
  error: FlowRunError,
  stepLabels: Record<string, string> = {},
): RunErrorView {
  const explanation =
    RUN_ERROR_EXPLANATIONS[error.code] ?? "Körningen kunde inte slutföras.";
  const summary = `${explanation} ${error.retryable ? RETRY_ADVICE : CHECK_FIRST_ADVICE}`;
  const stepName =
    error.details?.step_description ??
    (error.step_id ? stepLabels[error.step_id] : undefined);
  const step = error.step_order
    ? [`Steg ${error.step_order}`, stepName].filter(Boolean).join(" · ")
    : null;
  return { summary, step, detail: error.message };
}
