// All requests go to same-origin /api/* — Next rewrites these to the backend.
// The backend in turn proxies /api/eneo/* to Eneo with the module's service
// key and the short-lived module-user token from its HttpOnly session.

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

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(path, {
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

  if (!res.ok) {
    // Bounce to login bara om backend explicit signalerar att VÅR session
    // har gått ut (X-Auth-Required: session). En vanlig 401 från Eneo
    // (t.ex. ogiltig API-nyckel) får INTE trigga redirect — då hamnar vi
    // i en login-loop. Felet får i stället bubbla upp och visas i UI:t.
    if (
      res.status === 401 &&
      res.headers.get("X-Auth-Required") === "session" &&
      typeof window !== "undefined" &&
      !path.startsWith("/api/auth/") &&
      window.location.pathname !== "/"
    ) {
      window.location.replace("/");
    }
    throw await parseError(res);
  }

  if (res.status === 204) return undefined as T;

  const ctype = res.headers.get("content-type") || "";
  if (ctype.includes("application/json")) {
    return (await res.json()) as T;
  }
  return (await res.text()) as unknown as T;
}

// ---------- Config ----------

export interface AppConfig {
  demo_space_id: string | null;
  demo_space_name: string | null;
  /** Lista över alla konfigurerade spaces. Tom = inget hårdkodat space (frontend visar väljare). */
  demo_space_ids?: string[];
}

export async function getConfig() {
  return request<AppConfig>("/api/config");
}

// ---------- Auth ----------

export interface AuthenticatedUser {
  id: string;
  email: string;
  username?: string;
}

export async function logout() {
  return request<{ ok: true }>("/api/auth/logout", { method: "POST" });
}

export async function authStatus() {
  return request<{
    authenticated: boolean;
    user: AuthenticatedUser | null;
  }>("/api/auth/status");
}

// ---------- Eneo ----------

export interface SpaceSparse {
  id: string;
  name: string;
  description?: string | null;
  personal?: boolean;
}

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

export interface RunContract {
  flow_id: string;
  published_flow_version: number;
  form_fields?: FormField[];
  steps_requiring_input?: RunContractStepInput[];
  runtime_upload_policy?: FlowRuntimeUploadPolicy | null;
  recommended_run_payload?: Json;
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

export interface FlowRunPublic {
  id: string;
  flow_id: string;
  status: string; // se FlowRunStatus — behåll string för forward-compat
  output_payload_json?: {
    text?: string;
    structured?: { final_output?: string; [k: string]: unknown };
    [k: string]: unknown;
  } | null;
  result_files?: ResultFile[];
  error_message?: string | null;
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
  created_at: string;
  updated_at: string;
}

export interface ReviewEditRequest {
  expected_checkpoint_revision: number;
  current_payload_json: Json;
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

export interface RuntimeUploadTimeoutEvent {
  reason: RuntimeUploadTimeoutReason;
  timeoutMs: number;
}

interface UploadRequestOptions {
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  onTimeout?: (event: RuntimeUploadTimeoutEvent) => void;
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
        opts.onTimeout?.({ reason, timeoutMs });
        xhr.abort();
        rejectOnce(new ApiError(408, formatTimeoutReason(reason), null, reason));
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

export async function listSpaces() {
  return request<PaginatedResponse<SpaceSparse>>(
    "/api/eneo/spaces/?include_personal=true",
  );
}

/** Hämtar en specifik space direkt. Funkar även när /spaces/-listning är tom (scope-begränsade keys). */
export async function getSpace(spaceId: string) {
  return request<SpaceSparse>(`/api/eneo/spaces/${spaceId}/`);
}

export async function listFlows(
  spaceId: string,
  limit = 50,
  offset = 0,
) {
  const qs = new URLSearchParams({
    space_id: spaceId,
    limit: String(limit),
    offset: String(offset),
  });
  return request<PaginatedResponse<FlowSparsePublic>>(
    `/api/eneo/flows/?${qs.toString()}`,
  );
}

export async function getPublishedFlow(flowId: string) {
  return request<FlowPublished>(`/api/eneo/flows/${flowId}/published/`);
}

export async function getRunContract(flowId: string) {
  return request<RunContract>(`/api/eneo/flows/${flowId}/run-contract/`);
}

// input_format för det första steget som kräver input (lägst step_order).
// "audio" → mikrofon, "document"/"file"/"image" → dokument/fil.
export function firstInputFormat(contract: RunContract): string | null {
  const steps = [...(contract.steps_requiring_input ?? [])].sort(
    (a, b) => (a.step_order ?? 0) - (b.step_order ?? 0),
  );
  return steps[0]?.input_format?.toLowerCase() ?? null;
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

export async function getFlowGraph(flowId: string) {
  return request<FlowGraph>(`/api/eneo/flows/${flowId}/graph/`);
}

/** Returnerar `output_type` för det steg som matar flow_output-edgen (t.ex. "docx", "text"). */
export function getFlowOutputType(graph: FlowGraph): string | null {
  const flowOutputEdge = graph.edges.find((e) => e.kind === "flow_output");
  if (!flowOutputEdge) return null;
  const lastStep = graph.nodes.find((n) => n.id === flowOutputEdge.source);
  return lastStep?.output_type ?? null;
}

const TEXTUAL_OUTPUT_TYPES = new Set(["text", "markdown", "json"]);

/** True om output kan renderas som text/markdown i UI; false för binära artefakter (DOCX/PDF/...). */
export function isTextualOutput(outputType: string | null | undefined): boolean {
  if (!outputType) return true; // default: visa som text om vi inte vet
  return TEXTUAL_OUTPUT_TYPES.has(outputType.toLowerCase());
}

export async function startRun(
  flowId: string,
  body: Json,
  idempotencyKey: string,
) {
  return request<FlowRunPublic>(`/api/eneo/flows/${flowId}/runs/`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body),
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

export async function getArtifactSignedUrl(
  flowId: string,
  runId: string,
  fileId: string,
  expiresInSeconds = 3600,
) {
  // TODO(eneo-refactor): När Eneo-prod stabiliserats på nya specen, behåll bara `expires_in`
  // och uppdatera responstypen till `expires_at?: number`.
  return request<{ url: string; expires_at?: string | number }>(
    `/api/eneo/flows/${flowId}/runs/${runId}/artifacts/${fileId}/signed-url/`,
    {
      method: "POST",
      body: JSON.stringify({
        expires_in_seconds: expiresInSeconds, // legacy fältnamn
        expires_in: expiresInSeconds, // ny spec
      }),
    },
  );
}

// --- Cancel / redispatch / list ---

export async function cancelRun(flowId: string, runId: string) {
  return request<FlowRunPublic>(
    `/api/eneo/flows/${flowId}/runs/${runId}/cancel/`,
    { method: "POST" },
  );
}

export async function redispatchRun(flowId: string, runId: string) {
  return request<FlowRunRedispatchResponse>(
    `/api/eneo/flows/${flowId}/runs/${runId}/redispatch/`,
    { method: "POST" },
  );
}

export async function listRuns(flowId: string, limit = 50, offset = 0) {
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return request<OffsetPaginatedResponse<FlowRunPublic>>(
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
