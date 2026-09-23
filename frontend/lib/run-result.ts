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

const CANCELLED =
  "Körningen avbröts innan den blev klar. Starta en ny körning om du fortfarande behöver resultatet.";
const TOO_LARGE =
  "Inspelningen eller filen är för stor för flödet. Dela upp den i kortare delar och kör flödet för varje del.";
const SERVICE_UNAVAILABLE =
  "Tjänsten svarade inte eller var överbelastad. Vänta en stund innan du kör flödet igen.";
const STOPPED =
  "Körningen tog för lång tid eller slutade svara och avbröts. Försök igen och kontakta support med körnings-ID om det händer igen.";

// Eneos slutfelskoder som användaren av modulen kan förstå eller agera på.
// Övriga koder faller tillbaka på `retryable`.
const RUN_ERROR_SUMMARIES: Record<string, string> = {
  flow_run_cancelled: CANCELLED,
  flow_run_user_cancelled: CANCELLED,
  flow_review_rejected:
    "Resultatet avvisades i granskningen och körningen avslutades.",
  flow_review_expired:
    "Tiden för granskningen har gått ut och körningen har avbrutits.",
  flow_run_abandoned:
    "Körningen väntade för länge på att fortsätta och avslutades. Starta en ny körning om du behöver resultatet.",
  typed_io_transcription_failed:
    "Transkriberingen misslyckades. Kontrollera ljudet och försök igen.",
  typed_io_transcription_empty:
    "Transkriberingen gav ingen text. Kontrollera att inspelningen innehåller tal och försök igen.",
  typed_io_empty_extraction:
    "Ingen text kunde läsas ur filen. Välj en fil med läsbar text.",
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

export interface RunErrorView {
  /** Vad som hände och vad användaren kan göra, valt utifrån `code`. */
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
  const summary =
    RUN_ERROR_SUMMARIES[error.code] ??
    (error.retryable
      ? "Körningen kunde inte slutföras. Försök igen om en stund."
      : "Körningen kunde inte slutföras. Kontakta support med körnings-ID om felet återkommer.");
  const stepName =
    error.details?.step_description ??
    (error.step_id ? stepLabels[error.step_id] : undefined);
  const step = error.step_order
    ? [`Steg ${error.step_order}`, stepName].filter(Boolean).join(" · ")
    : null;
  return { summary, step, detail: error.message };
}
