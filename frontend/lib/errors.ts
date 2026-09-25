import { ApiError } from "./api";

/**
 * The one owner of what a failed request means to the user: a plain Swedish
 * sentence with the way on, whether trying again can help, and whether only
 * the flow's owner can fix it. Eneo's own message is for support and goes to
 * the console, never to the page; Eneo's codes decide the sentence.
 * (A finished run's failure is `run-result.ts`'s: it has its own contract.)
 */
export interface ErrorAdvice {
  message: string;
  /** Trying the same again can help: the network, a server error, a busy moment. */
  retry: boolean;
  /** Only the one responsible for the flow can fix it; the way on is another flow. */
  ownerMustFix: boolean;
}

const REPUBLISH = "Flödet behöver publiceras om av den som ansvarar för det innan det kan användas.";
const OWNER_FIX = "Flödet har ett fel som den som ansvarar för det behöver rätta innan det kan användas.";
const RELOAD = "Flödet har ändrats. Ladda om sidan och försök igen.";
const FIELDS = "En uppgift har fel format. Kontrollera uppgifterna och försök igen.";
const REQUIRED_FIELD = "Fyll i uppgifterna som krävs och försök igen.";
const TOO_LARGE = "Filen är större än flödet tar emot.";
const TOO_MANY_FILES = "Det är fler filer än flödet tar emot.";
const WRONG_TYPE = "Filtypen stöds inte.";
const FILE_UNUSABLE = "Filen kunde inte användas. Ladda upp den igen.";
const NO_ACCESS = "Du har inte behörighet till det här. Kontakta den som ansvarar för flödet om du behöver det.";
const MODULE_ACCESS = "Tal till text har inte behörighet till det här flödet. Kontakta den som ansvarar för Tal till text.";
const REVIEW_CHANGED = "Granskningen har ändrats. Ladda om sidan och försök igen.";

// The one responsible for the flow fixes these; trying again cannot help.
const OWNER_CODES: Record<string, string> = {
  flow_assistant_snapshot_republish_required: REPUBLISH,
  flow_definition_schema_version_missing: REPUBLISH,
  flow_definition_schema_version_unsupported: REPUBLISH,
  flow_definition_flow_id_invalid: REPUBLISH,
  flow_definition_checksum_mismatch: REPUBLISH,
  flow_definition_steps_invalid: OWNER_FIX,
  flow_input_contract_inapplicable: OWNER_FIX,
  flow_published_form_schema_invalid: OWNER_FIX,
  flow_review_policy_invalid: OWNER_FIX,
  flow_assistant_model_provider_required: OWNER_FIX,
  flow_run_reserved_input_payload_key: OWNER_FIX,
  flow_not_published: "Flödet är inte publicerat just nu och kan inte användas.",
};

const CODES: Record<string, string> = {
  // Starting a run: what was sent, and how to change it.
  flow_run_stale_version: "Flödet har uppdaterats. Kontrollera uppgifterna och försök igen.",
  flow_run_unknown_step_input: RELOAD,
  flow_run_runtime_input_disabled: RELOAD,
  flow_run_speaker_labels_not_selectable: RELOAD,
  flow_run_top_level_file_ids_not_supported: RELOAD,
  flow_input_upload_not_supported: "Det här flödet tar inte emot filuppladdning.",
  flow_run_required_step_input_missing: "Flödet saknar en fil det behöver. Lägg till den och försök igen.",
  flow_run_invalid_step_inputs: "Filerna passar inte flödet. Kontrollera dem och försök igen.",
  flow_run_step_input_file_too_large: TOO_LARGE,
  file_too_large: TOO_LARGE,
  flow_run_upload_pdf_exceeds_limit: "PDF-filen är större än flödet tar emot. Dela upp den i mindre delar.",
  flow_run_step_input_mimetype_rejected: WRONG_TYPE,
  unsupported_media_type: WRONG_TYPE,
  flow_run_step_input_max_files_exceeded: TOO_MANY_FILES,
  flow_run_aggregate_max_files_exceeded: TOO_MANY_FILES,
  flow_runtime_file_empty: "Filen är tom. Välj en fil med innehåll.",
  flow_run_file_not_accessible: FILE_UNUSABLE,
  flow_run_file_not_bound_to_flow: FILE_UNUSABLE,
  flow_run_input_payload_too_large: "Underlaget är större än flödet tar emot. Skicka mindre text eller färre filer.",
  flow_run_input_exceeds_limit: "Underlaget är större än flödet tar emot. Skicka mindre text eller färre eller mindre filer.",
  flow_input_required_field_missing: REQUIRED_FIELD,
  flow_input_required_field_empty: REQUIRED_FIELD,
  flow_input_type_mismatch: FIELDS,
  flow_input_invalid_number: "Ett tal i uppgifterna går inte att läsa. Rätta det och försök igen.",
  flow_input_invalid_date: "Ett datum i uppgifterna går inte att läsa. Rätta det och försök igen.",
  flow_input_invalid_option: "Ett val i uppgifterna finns inte längre. Välj ett av alternativen och försök igen.",
  flow_input_invalid_multiselect_value: FIELDS,
  flow_input_invalid_multiselect_type: FIELDS,
  flow_input_invalid_list_value: FIELDS,
  flow_input_invalid_list_type: FIELDS,
  flow_run_idempotency_conflict: "Inspelningen har redan skickats med andra uppgifter. Ladda om sidan för att se körningen.",
  flow_run_invalid_idempotency_key: "Dokumentet kunde inte skapas. Ladda om sidan och försök igen.",
  flow_run_concurrency_limit_reached: "För många körningar pågår just nu. Försök igen om en stund.",
  flow_dispatch_failed: "Körningen kunde inte startas just nu. Försök igen om en stund.",
  flow_live_transcription_unavailable: "Livetexten är inte tillgänglig. Spela in som vanligt, texten skapas när du är klar.",
  flow_run_input_file_not_found: "Ljudfilen för den här körningen kunde inte hittas.",
  flow_run_access_denied: "Du har inte tillgång till den här körningen.",
  // Access for Tal till text itself.
  insufficient_scope: MODULE_ACCESS,
  insufficient_resource_permission: MODULE_ACCESS,
  invalid_api_key: "Tal till text kan inte ansluta till Eneo just nu. Kontakta den som ansvarar för Tal till text.",
  upstream_unreachable: "Eneo gick inte att nå just nu. Försök igen om en stund.",
  invalid_json_response: "Servern svarade med något som inte gick att läsa. Försök igen om en stund.",
  // Review pauses (among them, confirming who is who).
  flow_review_stale_revision:
    "Granskningen har ändrats sedan du laddade sidan. Formuläret har uppdaterats — kontrollera och försök igen.",
  flow_review_expired: "Tiden för granskningen har gått ut och körningen har avbrutits.",
  flow_review_not_active: "Granskningen är inte längre aktiv.",
  flow_review_already_resumed: "Flödet har redan återupptagits.",
  flow_review_edit_not_allowed: "Det här steget kan bara godkännas, inte redigeras.",
  flow_review_edit_file_backed_unsupported: "Det här steget är för stort för att redigeras här. Godkänn eller avvisa det.",
  flow_review_edit_output_too_large: "Texten är för lång. Korta den och försök igen.",
  flow_review_idempotency_key_required: REVIEW_CHANGED,
  flow_review_step_result_not_found: REVIEW_CHANGED,
  flow_review_checkpoint_not_found: REVIEW_CHANGED,
  // Ended with the run: nothing more can be done on it.
  flow_review_cancelled: "Granskningen har avslutats. Ladda om sidan för att se hur det gick med körningen.",
  flow_review_not_approved: "Godkänn granskningen innan flödet kan fortsätta.",
  flow_review_reject_reason_required: "Skriv varför du avvisar resultatet.",
  flow_review_reject_reason_too_long: "Motiveringen är för lång. Korta den och försök igen.",
  flow_review_rejected: "Resultatet avvisades i granskningen och körningen avslutades.",
  typed_io_contract_violation: "Det du ändrade har fel form för det här steget. Rätta det och försök igen.",
  typed_io_validation_failed: "Det redigerade värdet har fel format för det här steget.",
  // Correcting a transcript.
  flow_transcript_corrections_stale_revision:
    "Transkriptet har ändrats av någon annan. Ändringarna har laddats om — gör om din rättning.",
  flow_transcript_corrections_invalid_occurrence:
    "Rättningen kunde inte förankras i transkriptet. Ladda om sidan och försök igen.",
  flow_transcript_corrections_invalid_speaker_edit: "Talarbytet kunde inte sparas. Ladda om sidan och försök igen.",
  flow_transcript_corrections_segments_unavailable: "Det här transkriptet saknar lagrade repliker och kan inte rättas.",
};

// Busy or briefly unreachable: the same request may go through a moment later.
const RETRY_CODES = new Set([
  "flow_run_concurrency_limit_reached",
  "flow_dispatch_failed",
  "upstream_unreachable",
  "invalid_json_response",
]);

// Errors this app's own upload client makes; their words are already Swedish.
const OWN_CODES = new Set([
  "network_error",
  "upload_aborted",
  "not_started",
  "stalled",
  "server_not_responding",
]);

// "Failed to fetch" in Chromium, "NetworkError when attempting to fetch resource." in Firefox, "Load failed" in Safari.
function looksLikeNetworkError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("failed to fetch") || m.includes("network") || m.includes("load failed");
}

// Each error's own words go to the console once, for support.
const logged = new WeakSet<object>();
function logForSupport(err: ApiError) {
  if (logged.has(err)) return;
  logged.add(err);
  console.warn(`Eneo svarade ${err.status}${err.code ? ` (${err.code})` : ""}: ${err.message}`);
}

const advice = (message: string, retry = false, ownerMustFix = false): ErrorAdvice => ({ message, retry, ownerMustFix });

export function errorAdvice(err: unknown): ErrorAdvice {
  if (err instanceof ApiError) {
    if (err.code && OWN_CODES.has(err.code)) return advice(err.message, true);
    logForSupport(err);
    if (err.code && OWNER_CODES[err.code]) return advice(OWNER_CODES[err.code], false, true);
    if (err.code && CODES[err.code]) return advice(CODES[err.code], RETRY_CODES.has(err.code));
    // Our own session (no code) has run out; Eneo's 401 always carries a code. The page asks for the new login in
    // place, so this is read after it.
    if (err.status === 401) return err.code ? advice(MODULE_ACCESS) : advice("Inloggningen hade gått ut och det här skickades inte. Försök igen.", true);
    if (err.status === 403) return advice(NO_ACCESS);
    if (err.status === 404) return advice("Det du letade efter finns inte längre.");
    if (err.status === 408 || err.status === 429) return advice("Eneo hann inte svara. Försök igen om en stund.", true);
    if (err.status === 413) return advice(TOO_LARGE);
    if (err.status === 415) return advice(WRONG_TYPE);
    if (err.status === 502 || err.status === 503 || err.status === 504) {
      return advice("Servern kunde inte nås just nu. Försök igen om en stund.", true);
    }
    if (err.status >= 500) return advice("Tjänsten svarade med ett fel. Försök igen om en stund.", true);
    if ((err.body as { retryable?: unknown } | null)?.retryable === true) {
      return advice("Det gick inte just nu. Försök igen om en stund.", true);
    }
    return advice("Det gick inte att genomföra. Kontakta den som ansvarar för Tal till text om det fortsätter.");
  }
  if (err instanceof Error) {
    if (err.name === "AbortError") return advice("Uppladdningen avbröts (tog för lång tid eller stannade upp).", true);
    if (looksLikeNetworkError(err.message)) {
      return advice("Anslutningen avbröts. Kontrollera nätverket och försök igen.", true);
    }
    // This app's own errors, in Swedish.
    return advice(err.message);
  }
  return advice("Ett okänt fel uppstod.");
}

/** What happened and what to do next, in plain Swedish. */
export function friendlyError(err: unknown): string {
  return errorAdvice(err).message;
}
