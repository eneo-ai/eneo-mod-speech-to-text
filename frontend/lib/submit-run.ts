/**
 * The one path from input to an Eneo run: upload each file to the flow's input
 * step, then start the run with the files in order. Network failures, 408,
 * 429 and 5xx are retried with backoff (1 s doubling to 60 s), sooner when the
 * connection comes back; any other 4xx stops with Eneo's typed error. Run
 * creation keeps one idempotency key across retries, so a lost response never
 * starts a second run.
 */

import {
  ApiError,
  deriveRunIdempotencyKey,
  startRun,
  uploadStepRuntimeFile,
  type FlowRunPublic,
  type Json,
  type RunContract,
} from "./api";
import type { OnlineStatus } from "./online-status";
import { formatBytes } from "./format";
import { IN_USE_ELSEWHERE, type RecordingStore } from "./recording-store";

const MAX_RETRY_DELAY_MS = 60_000;

export interface RetryWait {
  retryAt: number;
  retryNow: () => void;
}

export interface RetryOptions {
  online: OnlineStatus;
  signal?: AbortSignal;
  /** A wait before the next attempt began (or ended, with null). */
  onWait?: (wait: RetryWait | null) => void;
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof ApiError) {
    if (error.status === 0) return error.code === "network_error";
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  // fetch rejects with a TypeError when the network is down.
  return error instanceof TypeError;
}

export async function withRetry<T>(op: () => Promise<T>, opts: RetryOptions): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await op();
    } catch (error) {
      if (opts.signal?.aborted || !isRetryable(error)) throw error;
      await waitToRetry(Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** attempt), opts);
    }
  }
}

function waitToRetry(delayMs: number, { online, signal, onWait }: RetryOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: ApiError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopListening();
      signal?.removeEventListener("abort", cancel);
      onWait?.(null);
      if (error) reject(error);
      else resolve();
    };
    const retryNow = () => finish();
    const cancel = () => finish(new ApiError(0, "Uppladdningen avbröts.", null, "upload_aborted"));
    const timer = setTimeout(retryNow, delayMs);
    const stopListening = online.subscribe((isOnline) => isOnline && retryNow());
    signal?.addEventListener("abort", cancel, { once: true });
    onWait?.({ retryAt: Date.now() + delayMs, retryNow });
  });
}

export interface SubmitFile {
  blob: Blob;
  filename: string;
  /** Set when an earlier send already uploaded this file. */
  fileId?: string | null;
}

export interface SubmitProgress {
  filename: string;
  loaded: number;
  total: number;
  percent: number;
}

export interface SubmitDeps {
  upload: typeof uploadStepRuntimeFile;
  startRun: typeof startRun;
}

export interface SubmitParams extends RetryOptions {
  flowId: string;
  contract: RunContract;
  stepId: string | null;
  files: SubmitFile[];
  inputPayload: Record<string, unknown>;
  onProgress?: (progress: SubmitProgress) => void;
  onUploaded?: (index: number, fileId: string) => void | Promise<void>;
  /** Replaces the key derived from the request, as for a recording. */
  idempotencyKey?: string;
  /** Every file is uploaded; the run is being created. */
  onStarting?: () => void | Promise<void>;
}

export async function submitRun(
  params: SubmitParams,
  deps: SubmitDeps = { upload: uploadStepRuntimeFile, startRun },
): Promise<FlowRunPublic> {
  const { flowId, contract, stepId, files } = params;
  const step = contract.steps_requiring_input?.find((s) => s.step_id === stepId);
  if (files.length > 0 && !stepId) {
    throw new Error("Flödet saknar ett runtime-input-steg för filen.");
  }
  if (step?.max_files != null && files.length > step.max_files) {
    throw new Error(
      `Inspelningen består av ${files.length} delar, men flödet tar bara emot ${step.max_files} filer. Spara den som filer i stället.`,
    );
  }
  const maxBytes = step?.max_file_size_bytes;
  const tooLarge = maxBytes ? files.find((file) => file.blob.size > maxBytes) : undefined;
  if (tooLarge && maxBytes) {
    throw new Error(
      `Filen är för stor (${formatBytes(tooLarge.blob.size)}). Max: ${formatBytes(maxBytes)}.`,
    );
  }

  const total = files.reduce((sum, file) => sum + (file.fileId ? 0 : file.blob.size), 0);
  let sent = 0;
  const report = (filename: string, loaded: number) =>
    params.onProgress?.({
      filename,
      loaded,
      total,
      percent: total > 0 ? Math.round((loaded / total) * 100) : 100,
    });

  const fileIds: string[] = [];
  for (const [index, file] of files.entries()) {
    if (file.fileId) {
      fileIds.push(file.fileId);
      continue;
    }
    report(file.filename, sent);
    const uploaded = await withRetry(
      () =>
        deps.upload(flowId, stepId!, file.blob, file.filename, {
          signal: params.signal,
          runtimeUploadPolicy: contract.runtime_upload_policy,
          onProgress: ({ loaded }) => report(file.filename, sent + loaded),
        }),
      params,
    );
    sent += file.blob.size;
    fileIds.push(uploaded.id);
    await params.onUploaded?.(index, uploaded.id);
  }

  await params.onStarting?.();
  const body: Json = { expected_flow_version: contract.published_flow_version };
  if (fileIds.length > 0) body.step_inputs = { [stepId!]: { file_ids: fileIds } };
  if (Object.keys(params.inputPayload).length > 0) body.input_payload_json = params.inputPayload;
  const key =
    params.idempotencyKey ??
    (await deriveRunIdempotencyKey({
      flowId,
      expectedFlowVersion: contract.published_flow_version,
      body,
    }));
  return withRetry(() => deps.startRun(flowId, body, key), params);
}

const ALREADY_SENT = "Inspelningen har redan skickats, till exempel från en annan flik.";

/**
 * Sends a stored recording through `submitRun`, holding its lease so no other
 * tab sends or deletes it meanwhile. The run's idempotency key is the
 * recording's, whatever was uploaded, so Eneo makes one run per recording
 * even for a tab without Web Locks, or a send retried after a reload. Uploaded
 * parts are remembered, so a send that stops uploads only the rest next time;
 * the local copy is deleted once Eneo has accepted the run.
 */
export async function submitRecording(
  store: RecordingStore,
  id: string,
  params: Omit<SubmitParams, "files" | "onUploaded">,
  deps?: SubmitDeps,
): Promise<FlowRunPublic> {
  if (!(await store.lease(id))) throw new Error(IN_USE_ELSEWHERE);
  try {
    return await sendLeased(store, id, params, deps);
  } finally {
    store.release(id);
  }
}

async function sendLeased(
  store: RecordingStore,
  id: string,
  params: Omit<SubmitParams, "files" | "onUploaded">,
  deps?: SubmitDeps,
): Promise<FlowRunPublic> {
  const recording = await store.get(id);
  if (!recording) throw new Error("Inspelningen finns inte längre på enheten.");
  const files = await store.readParts(id);
  if (files.length === 0) throw new Error("Inspelningen innehåller inget ljud.");

  await store.setState(id, "uploading");
  let uploaded = false;
  let run: FlowRunPublic;
  try {
    run = await submitRun(
      {
        ...params,
        idempotencyKey: `flow-run:recording:${id}`,
        files: files.map((file) => ({ ...file, fileId: recording.parts[file.index].fileId })),
        onUploaded: (index, fileId) => store.setPartFileId(id, files[index].index, fileId),
        onStarting: async () => {
          uploaded = true;
          await store.setState(id, "uploaded");
          await params.onStarting?.();
        },
      },
      deps,
    );
  } catch (error) {
    // The recording's key already made a run, from another request: it is
    // sent. The copy is left as it is (another tab may have deleted it).
    if (error instanceof ApiError && error.code === "flow_run_idempotency_conflict") {
      throw new Error(ALREADY_SENT);
    }
    // Eneo refused the run: its uploads may be what it refused, so upload again next time.
    if (uploaded) await store.clearFileIds(id);
    await store.setState(id, "stopped");
    throw error;
  }
  // Eneo has the run; tidying up the local copy must not turn it into a failure.
  await store.accept(id, run.id).catch(() => undefined);
  return run;
}
