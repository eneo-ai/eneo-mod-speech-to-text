import { correctionWriteProblem } from "./transcript-corrections";
// All requests go to same-origin /api/* — Next rewrites these to the backend.
// The backend in turn proxies /api/eneo/* to Eneo with the module's service
// key and, in Eneo SSO mode, the short-lived module-user token from its
// HttpOnly session.

import { loginState } from "./login-state";
import { onlineStatus } from "./online-status";
import {
  resolveRuntimeUploadIdleTimeoutMs,
  resolveRuntimeUploadInitialTimeoutMs,
} from "./upload";

export type Json = Record<string, unknown>;

export class ApiError extends Error {
  status: number;
  code?: string;
  body: unknown;

  constructor(status: number, message: string, body: unknown, code?: string) {
    super(message);
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

async function parseError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  let code: string | undefined;
  let detail: string | undefined;
  try {
    body = await res.json();
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      if (typeof b.code === "string") code = b.code;
      // Vår egen proxy svarar `{ error: "upstream_unreachable", detail: "..." }`.
      // Eneo svarar `{ code: "...", detail: "..." }`. Båda mappas till `code`.
      else if (typeof b.error === "string") code = b.error;
      if (typeof b.detail === "string") detail = b.detail;
      else if (typeof b.message === "string") detail = b.message;
    }
  } catch {
    // ignore — body stays null
  }
  const msg = detail || code || `HTTP ${res.status}`;
  return new ApiError(res.status, msg, body, code);
}

/** Safe to send twice: a read, or a request Eneo answers once per Idempotency-Key. */
function replayable(init: RequestInit): boolean {
  const method = (init.method ?? "GET").toUpperCase();
  return method === "GET" || method === "HEAD" || new Headers(init.headers).has("Idempotency-Key");
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  again = false,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(init.body && !(init.body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    // fetch rejects with a TypeError when the network is down (not on abort).
    if (error instanceof TypeError) onlineStatus.reportNetworkFailure();
    throw error;
  }
  onlineStatus.reportReachable();

  if (!res.ok) {
    // Only the backend's own mark says OUR login ended (X-Auth-Required: session); Eneo's 401 (a wrong API key,
    // say) is an error to show. The page stays, and asks for a new login in place (loginState): a request that
    // is safe to send twice waits for it and goes again.
    if (res.status === 401 && res.headers.get("X-Auth-Required") === "session" && !path.startsWith("/api/auth/")) {
      loginState.ended();
      if (!again && replayable(init) && (await loginState.whenRenewed(init.signal))) {
        return request<T>(path, init, true);
      }
    }
    throw await parseError(res);
  }

  if (res.status === 204) return undefined as T;

  const ctype = res.headers.get("content-type") || "";
  if (ctype.includes("application/json")) {
    try {
      return (await res.json()) as T;
    } catch {
      // As the upload client does: a body that is not the JSON it claims is the request's own error.
      throw new ApiError(res.status, "Servern svarade med ogiltig JSON.", null, "invalid_json_response");
    }
  }
  return (await res.text()) as unknown as T;
}

// ---------- Config ----------

export interface AppConfig {
  /**
   * Hur flödeslistan frågar Eneo, avgjort av modulens inloggningsläge: med
   * Eneo SSO alla användarens spaces (space_id null), med åtkomstkod det
   * konfigurerade spacet; null när åtkomstkodsläget saknar ett space.
   */
  flow_list: { space_id: string | null } | null;
}

export async function getConfig() {
  return request<AppConfig>("/api/config");
}

/**
 * The organisation beside "Tal till text", a deployment setting of the
 * module's backend (GET /api/branding): Sundsvall's bundled logo
 * ("default"), the deployment's own ("custom", with a dark variant when
 * `dark_logo`), or the name as text (null). No organisation shows the
 * product name alone.
 */
export interface Branding {
  organization: { name: string; logo: "default" | "custom" | null; dark_logo: boolean } | null;
}

// ---------- Auth ----------

export interface AuthenticatedUser {
  id: string;
  email: string;
  username?: string;
}

export type AuthMode = "eneo_sso" | "access_code";

export interface AuthStatus {
  authenticated: boolean;
  auth_mode: AuthMode;
  user: AuthenticatedUser | null;
  /** Sekunder tills backend vill förnya Eneo-token; saknas när inget ska förnyas. */
  refresh_in?: number;
  /** Sekunder tills inloggningen tar slut (Eneos tak eller modulens eget); en ny inloggning flyttar det. */
  session_ends_in?: number;
}

export async function loginWithAccessCode(accessCode: string) {
  return request<{ ok: true }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ access_code: accessCode }),
  });
}

export async function logout() {
  return request<{ ok: true }>("/api/auth/logout", { method: "POST" });
}

export async function authStatus() {
  return request<AuthStatus>("/api/auth/status");
}

// ---------- Eneo ----------

export interface PaginatedResponse<T> {
  items: T[];
  count?: number;
  total_count?: number;
}

export interface FlowSparsePublic {
  id: string;
  name: string;
  description?: string | null;
  published_version?: number | null;
  is_published?: boolean;
  /** The flow's space; discovery lists every space the user belongs to. */
  space_id: string;
  space_name: string;
  /** How the flow takes its input: "audio", "document" or "file". */
  input_type?: FlowRuntimeInputFormat | string | null;
}

export interface FormField {
  name: string;
  label?: string | null;
  type?: string;
  required?: boolean;
  options?: unknown;
  order?: number;
  description?: string;
  default?: unknown;
}

export interface RunContractStepInput {
  step_id: string;
  step_order?: number;
  label?: string;
  description?: string;
  required?: boolean;
  input_format?: string;
  max_files?: number;
  max_file_size_bytes?: number;
  accepted_mimetypes?: string[];
}

export interface FlowRuntimeUploadPolicy {
  min_timeout_seconds: number;
  seconds_per_mebibyte: number;
  max_timeout_seconds: number;
  idle_timeout_seconds: number;
}

/**
 * Steg som kan pausa körningen i en review-checkpoint. Finns i run-kontraktet
 * så klienten kan förbereda granskningen innan körningen når awaiting_review.
 */
export interface FlowReviewStepContract {
  step_id: string;
  step_order: number;
  label?: string | null;
  review_mode: FlowStepReviewMode | string;
  output_type: FlowOutputType | string;
  expires_after_seconds?: number;
  output_contract?: Json | null;
}

export type LiveTranscriptionUnavailableReason =
  | "transcription_disabled"
  | "transcription_service_mode"
  | "model_unavailable"
  | "model_not_realtime";

/**
 * Val för ett flöde som transkriberar inspelat ljud. `live` säger om ljudsteget
 * kan visa live-text medan man spelar in. Körningen skickar `speaker_labels`
 * (boolean) i POST …/runs/ bara när `speaker_labels.selectable` är sant;
 * utan val gäller flödets `default`.
 */
export interface FlowTranscriptionContract {
  live: { available: boolean; reason: LiveTranscriptionUnavailableReason | null };
  speaker_labels: { selectable: boolean; required: boolean; default: boolean };
}

/**
 * Säkerhetsklassningen för flödets space: vilken information flödet får ta
 * emot, med namn och beskrivning som organisationen skrev dem.
 */
export interface FlowSecurityClassification {
  name: string;
  description: string | null;
  /** Högre nivå tillåter känsligare information. */
  security_level: number;
}

export interface RunContract {
  flow_id: string;
  published_flow_version: number;
  form_fields?: FormField[];
  steps_requiring_input?: RunContractStepInput[];
  steps_requiring_review?: FlowReviewStepContract[];
  runtime_upload_policy?: FlowRuntimeUploadPolicy | null;
  /** Null när flödet inte transkriberar ljud. */
  transcription?: FlowTranscriptionContract | null;
  /** Null när spacet saknar klassning eller organisationen stängt av klassningar. */
  security_classification?: FlowSecurityClassification | null;
}

export interface FlowPublished {
  id: string;
  name: string;
  description?: string | null;
  published_version: number;
}

export interface FilePublic {
  id: string;
  filename?: string;
  mimetype?: string;
  size?: number;
}

export interface ResultFile {
  file_id: string;
  name?: string;
  mimetype?: string | null;
  size?: number;
  file_type?: FileType | string;
  // Nya fält i den refaktorerade Eneo-specen (samtliga valfria här):
  step_id?: string;
  step_order?: number;
  attempt_no?: number;
  ordinal?: number;
  source?: string;
  checksum?: string;
  availability?: string;
}

/**
 * Körningens typade slutresultat, diskriminerat på `kind`. Eneo sätter det
 * bara när körningen blev klar; annars är det null.
 */
export type FlowRunResult =
  | { kind: "inline_text"; text: string }
  | { kind: "file_backed_text"; preview: string; file: ResultFile }
  | { kind: "structured"; value: unknown; output_contract: Json | null }
  | { kind: "artifact"; files: ResultFile[] }
  | { kind: "outbound_http"; delivery_status: "delivered" };

/**
 * Körningens typade slutfel. Förgrena på `code`; `message` är teknisk detalj
 * för support och ska inte tolkas. `retryable` säger om en ny körning är säker.
 */
export interface FlowRunError {
  schema_version?: number;
  code: string;
  message: string;
  source?: string | null;
  step_id?: string | null;
  step_order?: number | null;
  details?: { step_description?: string | null; [k: string]: unknown } | null;
  retryable: boolean;
}

export interface FlowRunPublic {
  id: string;
  flow_id: string;
  status: string; // se FlowRunStatus — behåll string för forward-compat
  result?: FlowRunResult | null;
  result_files?: ResultFile[];
  error?: FlowRunError | null;
  created_at?: string;
  updated_at?: string;
  started_at?: string;
  finished_at?: string;
  // Nya fält i den refaktorerade specen:
  flow_version?: number;
  trace_id?: string;
  revision?: number;
  cancelled_at?: string | null;
  input_payload_json?: Json | null;
  job_id?: string | null;
}

export interface FlowRunStep {
  id: string;
  step_id: string;
  /** Saknas i ny spec — härled från GraphResponse.nodes vid behov. */
  step_name?: string;
  /** Saknas i ny spec — härled från GraphResponse.nodes vid behov. */
  step_label?: string;
  step_order?: number;
  status: string; // se FlowStepResultStatus
  started_at?: string;
  completed_at?: string;
  finished_at?: string;
  [k: string]: unknown;
}

// ---------- Nya typer för refaktorerade Eneo-flows ----------

export type FlowRunStatus =
  | "queued"
  | "running"
  | "awaiting_review"
  | "completed"
  | "failed"
  | "cancelled";

export type FlowStepResultStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type FlowStepReviewMode = "view" | "edit";

export type FlowTemplateAssetStatus =
  | "ready"
  | "needs_action"
  | "read_only"
  | "unavailable";

export type FlowOutputType = "text" | "json" | "pdf" | "docx";
export type FlowOutputMode =
  | "pass_through"
  | "http_post"
  | "transcribe_only"
  | "template_fill";
export type FlowOutputDelivery = "payload" | "artifact" | "outbound_http";
export type FlowRuntimeInputFormat = "document" | "audio" | "file";
export type FileType = "text" | "image" | "audio" | "document";
export type ContentDisposition = "attachment" | "inline";

export type FlowRunReviewCheckpointState =
  | "awaiting_review"
  | "edited"
  | "approved"
  | "rejected"
  | "resumed"
  | "cancelled"
  | "expired";

export interface OffsetPaginatedResponse<T> {
  items: T[];
  has_more: boolean;
  count: number;
}

export interface FlowRunReviewCheckpointPublic {
  id: string;
  flow_id: string;
  flow_run_id: string;
  step_id: string;
  step_order: number;
  attempt_no: number;
  state: FlowRunReviewCheckpointState;
  revision: number;
  schema_version: number;
  original_payload_json?: Json | null;
  current_payload_json?: Json | null;
  step_label?: string | null;
  review_mode?: FlowStepReviewMode | null;
  output_type?: FlowOutputType | null;
  step_snapshot_available?: boolean;
  output_contract?: Json | null;
  next_step_ids?: string[] | null;
  approved_at?: string | null;
  rejected_at?: string | null;
  resumed_at?: string | null;
  cancelled_at?: string | null;
  expires_at?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `edited_value` är stegets korrigerade output i sig — en sträng för ett
 * `text`-steg, ett JSON-objekt/array för ett `json`-steg — inte payload-
 * kuvertet. Eneo härleder `text`/`structured` server-side och avvisar
 * okända fält (extra="forbid").
 */
export type ReviewEditedValue = string | Json | unknown[];

export interface ReviewEditRequest {
  expected_checkpoint_revision: number;
  edited_value: ReviewEditedValue;
}

export interface ReviewApproveRequest {
  expected_checkpoint_revision: number;
}
export interface ReviewRejectRequest {
  expected_checkpoint_revision: number;
  reason: string;
}
export interface ReviewResumeRequest {
  expected_checkpoint_revision: number;
}
export interface ReviewResumeResponse {
  checkpoint: FlowRunReviewCheckpointPublic;
  run: FlowRunPublic;
}

export function isReviewCheckpointApproved(
  checkpoint: FlowRunReviewCheckpointPublic | null | undefined,
): checkpoint is FlowRunReviewCheckpointPublic {
  return checkpoint?.state === "approved" || checkpoint?.state === "resumed";
}

export function reviewResumeIdempotencyKey(
  runId: string,
  checkpointId: string,
): string {
  return `review-resume:${runId}:${checkpointId}`;
}

/**
 * Run-kontraktet exponerar inte stegets output_mode, men Eneo pinnar ett
 * speaker-mapping-steg till ett fast output_contract vars `speakers[]`-items
 * har en `label` med mönstret `^SPEAKER_\d{2,}$`. Det räcker för att känna
 * igen steget innan körningen startar.
 */
export function isSpeakerMappingReviewStep(
  step: FlowReviewStepContract | null | undefined,
): boolean {
  if (!step || step.review_mode !== "edit" || step.output_type !== "json") {
    return false;
  }
  const contract = step.output_contract as
    | { properties?: Record<string, unknown> }
    | null
    | undefined;
  const speakers = contract?.properties?.speakers as
    | { items?: { properties?: Record<string, unknown> } }
    | undefined;
  const label = speakers?.items?.properties?.label as
    | { pattern?: unknown }
    | undefined;
  return (
    typeof label?.pattern === "string" && label.pattern.includes("SPEAKER_")
  );
}

export function speakerMappingReviewSteps(
  contract: RunContract | null | undefined,
): FlowReviewStepContract[] {
  return (contract?.steps_requiring_review ?? []).filter(
    isSpeakerMappingReviewStep,
  );
}

export interface FlowRunRedispatchResponse {
  run: FlowRunPublic;
  redispatched_count: number;
}

export interface FlowTemplateAssetPublic {
  id: string;
  flow_id: string;
  file_id: string;
  name: string;
  checksum: string;
  mimetype?: string | null;
  placeholders: string[];
  status: FlowTemplateAssetStatus;
  last_updated_by_name?: string | null;
  can_edit: boolean;
  can_download: boolean;
  can_select: boolean;
  can_inspect: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface FlowRunStepRerunRequest {
  expected_run_revision: number;
  reason: string;
  input_payload_json?: Json | null;
  step_inputs?: Json | null;
}
export interface FlowRunStepRerunResponse {
  operation_id: string;
  run: FlowRunPublic;
  rerun_step_id: string;
  new_attempt_no: number;
  invalidated_step_ids: string[];
  status: string;
}

export interface FlowRunEvidenceResponse {
  run: FlowRunPublic;
  definition_snapshot: Json;
  step_results: FlowRunStep[];
  // Övriga fält håller vi löst typade tills UI behöver dem.
  step_attempts: Json[];
  result_files: ResultFile[];
  rerun_operations: Json[];
  rerun_invalidated_steps: Json[];
  review_checkpoints: Json[];
  debug_export: Json;
}

export interface FlowRunEvidenceExportResponse {
  schema_version: string;
  generated_at: string;
  content_hash: string;
  manifest: Json;
  summary: Json;
  redaction: Json;
  bundle: Json;
}

export interface UploadProgress {
  loaded: number;
  total: number | null;
  percent: number | null;
}

export type RuntimeUploadTimeoutReason =
  | "not_started"
  | "stalled"
  | "server_not_responding";

interface UploadRequestOptions {
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  runtimeUploadPolicy?: FlowRuntimeUploadPolicy | null;
}

function formatTimeoutReason(reason: RuntimeUploadTimeoutReason): string {
  switch (reason) {
    case "not_started":
      return "Uppladdningen startade inte i tid.";
    case "stalled":
      return "Uppladdningen stannade utan nätverksprogress.";
    case "server_not_responding":
      return "Filen skickades, men servern svarade inte i tid.";
  }
}

function parseXhrError(xhr: XMLHttpRequest): ApiError {
  let body: unknown = null;
  let code: string | undefined;
  let detail: string | undefined;
  try {
    body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      if (typeof b.code === "string") code = b.code;
      if (typeof b.detail === "string") detail = b.detail;
      else if (typeof b.message === "string") detail = b.message;
    }
  } catch {
    body = xhr.responseText || null;
  }
  return new ApiError(xhr.status, detail || code || `HTTP ${xhr.status}`, body, code);
}

function requestMultipartWithProgress<T>(
  path: string,
  formData: FormData,
  opts: UploadRequestOptions & { fileSizeBytes: number } = {
    fileSizeBytes: 0,
  },
): Promise<T> {
  const initialTimeoutMs = resolveRuntimeUploadInitialTimeoutMs(
    opts.fileSizeBytes,
    opts.runtimeUploadPolicy,
  );
  const idleTimeoutMs = resolveRuntimeUploadIdleTimeoutMs(opts.runtimeUploadPolicy);

  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let lastUploadedBytes = 0;
    let settled = false;

    const clearScheduledTimeout = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = null;
    };

    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearScheduledTimeout();
      reject(error);
    };

    const scheduleTimeout = (
      timeoutMs: number,
      reason: RuntimeUploadTimeoutReason,
    ) => {
      clearScheduledTimeout();
      timeoutId = setTimeout(() => {
        // Settled first: abort() fires "abort" before it returns, which would read as a cancel.
        rejectOnce(new ApiError(408, formatTimeoutReason(reason), null, reason));
        xhr.abort();
      }, timeoutMs);
    };

    scheduleTimeout(initialTimeoutMs, "not_started");

    xhr.upload.onprogress = (event) => {
      if (event.loaded <= lastUploadedBytes) return;
      lastUploadedBytes = event.loaded;
      const total = event.lengthComputable && event.total > 0 ? event.total : null;
      const percent = total ? Math.round((event.loaded / total) * 100) : null;
      opts.onProgress?.({ loaded: event.loaded, total, percent });

      const uploadComplete = total != null && event.loaded >= total;
      scheduleTimeout(
        uploadComplete ? Math.max(initialTimeoutMs, idleTimeoutMs) : idleTimeoutMs,
        uploadComplete ? "server_not_responding" : "stalled",
      );
    };

    xhr.onload = () => {
      onlineStatus.reportReachable();
      // The login ended: the dialog asks for a new one, and the send is the user's to start again.
      if (xhr.status === 401 && xhr.getResponseHeader("X-Auth-Required") === "session") loginState.ended();
      if (settled) return;
      settled = true;
      clearScheduledTimeout();
      if (xhr.status >= 200 && xhr.status < 300) {
        if (xhr.status === 204 || !xhr.responseText) {
          resolve(undefined as T);
          return;
        }
        const ctype = xhr.getResponseHeader("content-type") || "";
        try {
          resolve(
            ctype.includes("application/json")
              ? (JSON.parse(xhr.responseText) as T)
              : (xhr.responseText as T),
          );
        } catch {
          reject(
            new ApiError(
              xhr.status,
              "Servern svarade med ogiltig JSON.",
              xhr.responseText,
              "invalid_json_response",
            ),
          );
        }
        return;
      }
      reject(parseXhrError(xhr));
    };

    xhr.onerror = () => {
      onlineStatus.reportNetworkFailure();
      rejectOnce(
        new ApiError(
          0,
          "Nätverksfel vid uppladdning. Kontrollera anslutningen och försök igen.",
          null,
          "network_error",
        ),
      );
    };

    xhr.onabort = () => {
      rejectOnce(
        new ApiError(0, "Uppladdningen avbröts.", null, "upload_aborted"),
      );
    };

    opts.signal?.addEventListener(
      "abort",
      () => {
        xhr.abort();
      },
      { once: true },
    );

    xhr.open("POST", path);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader(
      "X-Upload-Timeout-Seconds",
      String(Math.ceil(initialTimeoutMs / 1000)),
    );
    xhr.send(formData);
  });
}

function stableSortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSortJson);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = stableSortJson((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// ---------- API-anrop ----------

/**
 * One page of the published flows the user can run. Without `spaceId` Eneo
 * lists every space the user belongs to, narrowed by the module key's scope;
 * items come oldest first and `has_more` says whether another page follows.
 */
export async function listPublishedFlows({ limit, offset, spaceId }: { limit: number; offset: number; spaceId?: string }) {
  const query = new URLSearchParams({ published_only: "true", limit: String(limit), offset: String(offset) });
  if (spaceId) query.set("space_id", spaceId);
  return request<OffsetPaginatedResponse<FlowSparsePublic>>(`/api/eneo/flows/?${query}`);
}

export async function getPublishedFlow(flowId: string) {
  return request<FlowPublished>(`/api/eneo/flows/${flowId}/published/`);
}

export async function getRunContract(flowId: string) {
  return request<RunContract>(`/api/eneo/flows/${flowId}/run-contract/`);
}

// ---------- Flow graph ----------

export interface FlowGraphNode {
  id: string;
  label: string;
  type: string; // "input" | "output" | "llm" | ...
  step_order: number | null;
  input_source: string | null;
  input_type: string | null;
  output_type: string | null; // "text" | "json" | "docx" | "pdf" | ...
  output_mode: string | null;
  /** Only on a run-pinned graph (`?run_id=`): the step's status in that run, null before it has one. */
  run_status?: FlowStepResultStatus | string | null;
}

export interface FlowGraphEdge {
  source: string;
  target: string;
  kind: string; // "flow_input" | "previous_step" | "flow_output" | "input_bindings.X"
  label: string | null;
}

export interface FlowGraph {
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
}

/**
 * The graph of the version a run pinned, each step annotated with its status
 * in that run. Unlike the step results it is not audited per read, so it is
 * what a progress poll reads.
 */
export async function getRunGraph(flowId: string, runId: string) {
  const query = new URLSearchParams({ run_id: runId });
  return request<FlowGraph>(`/api/eneo/flows/${flowId}/graph/?${query}`);
}

export async function startRun(
  flowId: string,
  body: Json,
  idempotencyKey: string,
  signal?: AbortSignal,
) {
  return request<FlowRunPublic>(`/api/eneo/flows/${flowId}/runs/`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body),
    signal,
  });
}

export async function deriveRunIdempotencyKey(params: {
  flowId: string;
  expectedFlowVersion: number;
  body: Json;
}): Promise<string> {
  const normalized = stableSortJson({
    flow_id: params.flowId,
    expected_flow_version: params.expectedFlowVersion,
    body: params.body,
  });
  return `flow-run:${await sha256Hex(JSON.stringify(normalized))}`;
}

/**
 * Lättviktig status för polling. Eneo audit-loggar varje läsning av
 * körningens detalj (`GET …/runs/{id}/`), men inte status-endpointen, så
 * polla den här och hämta detaljen först när körningen är klar.
 */
export interface FlowRunSummary {
  id: string;
  flow_id: string;
  status: string;
  flow_version?: number;
  revision?: number;
  trace_id?: string;
  created_at?: string;
  updated_at?: string;
  [k: string]: unknown;
}

export async function getRunStatus(flowId: string, runId: string) {
  return request<FlowRunSummary>(
    `/api/eneo/flows/${flowId}/runs/${runId}/status/`,
  );
}

export async function getRun(flowId: string, runId: string) {
  return request<FlowRunPublic>(`/api/eneo/flows/${flowId}/runs/${runId}/`);
}

export async function getRunSteps(flowId: string, runId: string) {
  // Eneo returns a bare list here, not a paginated wrapper.
  const res = await request<FlowRunStep[] | PaginatedResponse<FlowRunStep>>(
    `/api/eneo/flows/${flowId}/runs/${runId}/steps/`,
  );
  if (Array.isArray(res)) return res;
  return res.items ?? [];
}

// --- Cancel / redispatch / list ---

export async function cancelRun(flowId: string, runId: string) {
  return request<FlowRunPublic>(
    `/api/eneo/flows/${flowId}/runs/${runId}/cancel/`,
    { method: "POST" },
  );
}

/** Eneo's answer to a retry: the child run, and which completed steps it reuses. */
export interface FlowRunRetryPublic {
  run: FlowRunPublic;
  /** False when the same key replays a retry Eneo already accepted. */
  created: boolean;
  source_run_id: string;
  first_executed_step_order: number;
  reused_step_orders: number[];
}

/**
 * Continues a failed run from its first unfinished step: Eneo creates a child
 * run that reuses the completed steps (a long recording is not transcribed
 * again) and keeps the source's inputs, files and choices.
 */
export async function retryFlowRunFromFailedStep(flowId: string, runId: string, idempotencyKey: string) {
  return request<FlowRunRetryPublic>(`/api/eneo/flows/${flowId}/runs/${runId}/retry/`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
  });
}

export async function redispatchRun(flowId: string, runId: string) {
  return request<FlowRunRedispatchResponse>(
    `/api/eneo/flows/${flowId}/runs/${runId}/redispatch/`,
    { method: "POST" },
  );
}

/**
 * The caller's latest runs of a flow. `mine=true` keeps a colleague's runs
 * out, which Eneo would otherwise list for a space admin or the flow's owner;
 * a module session counts as its signed-in user.
 */
export async function listOwnRuns(flowId: string, { limit = 10, offset = 0 }: { limit?: number; offset?: number } = {}) {
  const qs = new URLSearchParams({ mine: "true", limit: String(limit), offset: String(offset) });
  return request<OffsetPaginatedResponse<FlowRunSummary>>(
    `/api/eneo/flows/${flowId}/runs/?${qs.toString()}`,
  );
}

// --- Step rerun + step runtime-files ---

export async function rerunStep(
  flowId: string,
  runId: string,
  stepId: string,
  body: FlowRunStepRerunRequest,
  idempotencyKey: string,
) {
  return request<FlowRunStepRerunResponse>(
    `/api/eneo/flows/${flowId}/runs/${runId}/steps/${stepId}/rerun/`,
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body),
    },
  );
}

export async function uploadStepRuntimeFile(
  flowId: string,
  stepId: string,
  file: Blob,
  filename: string,
  opts: UploadRequestOptions = {},
) {
  const fd = new FormData();
  fd.append("upload_file", file, filename);
  return requestMultipartWithProgress<FilePublic>(
    `/api/eneo/flows/${flowId}/steps/${stepId}/runtime-files/`,
    fd,
    { ...opts, fileSizeBytes: file.size },
  );
}

// --- Transkript: ordtider och ljud ---

export interface TranscriptWordsResponse {
  flow_run_id: string;
  step_id: string;
  segments_hash: string;
  alignment: string | null;
  stale: boolean;
  segments: {
    segment_index: number;
    words: { word: string; start: number; end: number; probability: number | null }[];
  }[];
}

/** Ordtider för ett transkriberingssteg. Eneo svarar 404 när inga finns. */
export async function getTranscriptWords(
  flowId: string,
  runId: string,
  stepId: string,
) {
  return request<TranscriptWordsResponse>(
    `/api/eneo/flows/${flowId}/runs/${runId}/steps/${stepId}/transcript-words/`,
  );
}

/** A text file the run produced (its content as text), through the module's artifact route. */
export async function getRunArtifactText(flowId: string, runId: string, fileId: string) {
  return request<string>(`/api/eneo/flows/${flowId}/runs/${runId}/artifacts/${fileId}/content`);
}

/**
 * One page (200 segments) of the transcript an attempt stored. Present: the
 * segments with their absolute index, the source hash corrections must carry,
 * and on the first page the speaker review. Omitted: Eneo kept no segments
 * (the step's text is then the transcript). Unavailable: written before Eneo
 * kept sources.
 */
export type TranscriptSourcePage =
  | {
      status: "present";
      source_hash: string;
      next_segment_index: number | null;
      segments: Record<string, unknown>[];
      speaker_review?: unknown;
    }
  | { status: "omitted"; reason: number }
  | { status: "unavailable_pre_row" };

export async function getTranscriptSource(
  flowId: string,
  runId: string,
  stepId: string,
  attemptNo: number,
  startSegmentIndex: number,
) {
  const query = new URLSearchParams({ start_segment_index: String(startSegmentIndex) });
  return request<TranscriptSourcePage>(
    `/api/eneo/flows/${flowId}/runs/${runId}/steps/${stepId}/attempts/${attemptNo}/transcript-source/?${query}`,
  );
}

/**
 * Same-origin ljudkälla för en av körningens inmatade filer. Modulens backend
 * hämtar den signerade Eneo-URL:en med sina egna credentials och strömmar
 * ljudet vidare med Range-stöd, så browsern aldrig ser Eneos token.
 */
export function inputFileAudioUrl(
  flowId: string,
  runId: string,
  fileId: string,
): string {
  return `/api/eneo/flows/${flowId}/runs/${runId}/input-files/${fileId}/audio`;
}

/**
 * Same-origin address of a file the run generated. The module backend streams
 * it from Eneo the same way, under the name Eneo gave it; a PDF can open
 * inline (a frame on this origin, or a new tab), anything else downloads.
 */
export function runArtifactUrl(flowId: string, runId: string, fileId: string, inline = false): string {
  const query = new URLSearchParams({ disposition: inline ? "inline" : "attachment" });
  return `/api/eneo/flows/${flowId}/runs/${runId}/artifacts/${fileId}/content?${query}`;
}

// --- Transkriptkorrigeringar ---

export interface TranscriptCorrectionsPublic {
  schema_version?: number;
  segments_hash?: string | null;
  flow_run_id: string;
  step_id: string;
  occurrences: {
    segment_index: number;
    char_start: number;
    char_end: number;
    original: string;
    corrected: string;
  }[];
  speaker_edits: {
    segment_index: number;
    char_start: number | null;
    char_end: number | null;
    original: string | null;
    original_speaker: string | null;
    speaker: string | null;
    decision?: "confirmed" | "unresolved";
  }[];
  revision: number;
  stale: boolean;
  edited_by_principal_type?: string;
  created_at?: string;
  updated_at?: string;
}

/** Alla korrigeringsuppsättningar för körningen, en per transkriberingssteg. */
export async function listTranscriptCorrections(flowId: string, runId: string) {
  const res = await request<
    TranscriptCorrectionsPublic[] | PaginatedResponse<TranscriptCorrectionsPublic>
  >(`/api/eneo/flows/${flowId}/runs/${runId}/transcript-corrections/`);
  if (Array.isArray(res)) return res;
  return res.items ?? [];
}

export interface TranscriptCorrectionsEditRequest {
  schema_version?: 2 | 3;
  segments_hash?: string;
  /** null skapar den första uppsättningen; annars senast kända revision. */
  expected_revision: number | null;
  occurrences: TranscriptCorrectionsPublic["occurrences"];
  speaker_edits: TranscriptCorrectionsPublic["speaker_edits"];
}

/** Ersätter hela uppsättningen för steget (replace-semantik). */
export async function saveTranscriptCorrections(
  flowId: string,
  runId: string,
  stepId: string,
  body: TranscriptCorrectionsEditRequest,
) {
  const problem = correctionWriteProblem({ ...body, schemaVersion: body.schema_version, segmentsHash: body.segments_hash, revision: body.expected_revision });
  if (problem) throw new Error(problem);
  return request<TranscriptCorrectionsPublic>(
    `/api/eneo/flows/${flowId}/runs/${runId}/steps/${stepId}/transcript-corrections/`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
}

export interface FlowTranscriptRegenerationPublic {
  /** The new run: the source run, its document and files stay as they were. */
  run: FlowRunPublic;
  /** False when the same request and key replayed an accepted run. */
  created: boolean;
  source_run_id: string;
  correction_revision: number | null;
  first_regenerated_step_id: string;
}

/**
 * A new run of the same published flow version from the reviewed transcript:
 * the transcription step (and a speaker naming step after it) is taken as
 * reviewed, the steps after it run again. The same key and request replay the
 * accepted run; stale revisions, a changed publication or an unsupported flow
 * layout are refused before anything is created.
 */
export async function regenerateTranscript(
  flowId: string,
  runId: string,
  stepId: string,
  body: { expected_run_revision: number; expected_correction_revision: number | null; segments_hash: string },
  idempotencyKey: string,
) {
  return request<FlowTranscriptRegenerationPublic>(
    `/api/eneo/flows/${flowId}/runs/${runId}/steps/${stepId}/transcript-regenerations/`,
    { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify(body) },
  );
}

// --- Evidence ---

export async function getRunEvidence(flowId: string, runId: string) {
  return request<FlowRunEvidenceResponse>(
    `/api/eneo/flows/${flowId}/runs/${runId}/evidence/`,
  );
}

export async function exportRunEvidence(flowId: string, runId: string) {
  return request<FlowRunEvidenceExportResponse>(
    `/api/eneo/flows/${flowId}/runs/${runId}/evidence/export`,
  );
}

// --- Review checkpoints ---

export async function getActiveReviewCheckpoint(flowId: string, runId: string) {
  return request<FlowRunReviewCheckpointPublic | null>(
    `/api/eneo/flows/${flowId}/runs/${runId}/review-checkpoints/active/`,
  );
}

export async function editReviewCheckpoint(
  flowId: string,
  runId: string,
  checkpointId: string,
  body: ReviewEditRequest,
) {
  return request<FlowRunReviewCheckpointPublic>(
    `/api/eneo/flows/${flowId}/runs/${runId}/review-checkpoints/${checkpointId}/`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
}

export async function approveReviewCheckpoint(
  flowId: string,
  runId: string,
  checkpointId: string,
  body: ReviewApproveRequest,
) {
  return request<FlowRunReviewCheckpointPublic>(
    `/api/eneo/flows/${flowId}/runs/${runId}/review-checkpoints/${checkpointId}/approve/`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export async function rejectReviewCheckpoint(
  flowId: string,
  runId: string,
  checkpointId: string,
  body: ReviewRejectRequest,
) {
  return request<FlowRunReviewCheckpointPublic>(
    `/api/eneo/flows/${flowId}/runs/${runId}/review-checkpoints/${checkpointId}/reject/`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export async function resumeReviewCheckpoint(
  flowId: string,
  runId: string,
  checkpointId: string,
  body: ReviewResumeRequest,
  idempotencyKey: string,
) {
  return request<ReviewResumeResponse>(
    `/api/eneo/flows/${flowId}/runs/${runId}/review-checkpoints/${checkpointId}/resume/`,
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body),
    },
  );
}

// --- DOCX templates ---

export async function listFlowTemplateFiles(flowId: string) {
  // Eneo kan returnera antingen bare array eller paginerat wrapper.
  const res = await request<
    | FlowTemplateAssetPublic[]
    | PaginatedResponse<FlowTemplateAssetPublic>
    | OffsetPaginatedResponse<FlowTemplateAssetPublic>
  >(`/api/eneo/flows/${flowId}/template-files/`);
  if (Array.isArray(res)) return res;
  return res.items ?? [];
}

export async function uploadFlowTemplateFile(
  flowId: string,
  file: Blob,
  filename: string,
) {
  const fd = new FormData();
  fd.append("upload_file", file, filename);
  return request<FlowTemplateAssetPublic>(
    `/api/eneo/flows/${flowId}/template-files/`,
    { method: "POST", body: fd },
  );
}

export async function getFlowTemplateSignedUrl(
  flowId: string,
  fileId: string,
  expiresInSeconds = 3600,
) {
  // TODO(eneo-refactor): När prod är stabil på nya specen, behåll bara `expires_in`.
  return request<{ url: string; expires_at?: string | number }>(
    `/api/eneo/flows/${flowId}/template-files/${fileId}/signed-url/`,
    {
      method: "POST",
      body: JSON.stringify({
        expires_in_seconds: expiresInSeconds, // legacy fältnamn
        expires_in: expiresInSeconds, // ny spec
      }),
    },
  );
}
