import { ApiError } from "./api";

const messages: Record<string, string> = {
  flow_not_published: "Det här flödet är inte publicerat och kan inte köras.",
  flow_input_upload_not_supported:
    "Det här flödet tar inte emot filuppladdning.",
  file_too_large: "Filen är för stor.",
  unsupported_media_type: "Filtypen stöds inte.",
  flow_run_concurrency_limit_reached:
    "För många samtidiga körningar pågår. Vänta lite och försök igen.",
  flow_run_idempotency_conflict:
    "Idempotency-konflikt. Försök igen.",
  insufficient_scope:
    "API-nyckeln har fel scope för det här flödet eller spacet.",
  insufficient_resource_permission:
    "API-nyckeln saknar behörighet till resursen.",
  invalid_api_key:
    "API-nyckeln är ogiltig eller har återkallats. Uppdatera nyckeln i konfigurationen.",
  upstream_unreachable:
    "Uppladdningen tog för lång tid eller avbröts. Prova att starta om körningen, eller dela inspelningen i kortare delar.",
};

// Texten på en TypeError från fetch när nätverket bryts ("Failed to fetch" i
// Chromium, "NetworkError when attempting to fetch resource." i Firefox, etc).
function looksLikeNetworkError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("failed to fetch") ||
    m.includes("network") ||
    m.includes("load failed")
  );
}

export function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code && messages[err.code]) return messages[err.code];
    if (err.status === 401) {
      // Vår egen "Not authenticated" från backend saknar `code`-fält.
      // Eneo:s 401 har alltid en `code` (invalid_api_key, etc).
      if (!err.code) return "Sessionen har gått ut. Logga in igen.";
      return err.message || "Anropet nekades av Eneo.";
    }
    if (err.status === 403) {
      return err.message || "Behörighet saknas.";
    }
    if (err.status === 413) return "Filen är för stor.";
    if (err.status === 415) return "Filtypen stöds inte.";
    if (err.status === 502 || err.status === 503 || err.status === 504) {
      return "Servern kunde inte nås just nu. Försök igen om en stund.";
    }
    return err.message || `HTTP ${err.status}`;
  }
  if (err instanceof Error) {
    if (err.name === "AbortError") {
      return "Uppladdningen avbröts (tog för lång tid eller stannade upp).";
    }
    if (looksLikeNetworkError(err.message)) {
      return "Anslutningen avbröts. Kontrollera nätverket och försök igen.";
    }
    return err.message;
  }
  return "Ett okänt fel uppstod.";
}
