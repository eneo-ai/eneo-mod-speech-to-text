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
  getRunContract,
  retryFlowRunFromFailedStep,
  startRun,
  uploadStepRuntimeFile,
  type FlowRunPublic,
  type FlowRunStep,
  type Json,
  type RunContract,
} from "./api";
import { friendlyError } from "./errors";
import type { OnlineStatus } from "./online-status";
import { formatBytes } from "./format";
import { IN_USE_ELSEWHERE, NOT_ON_DEVICE, type RecordingStore, type RunRequest } from "./recording-store";
import { selectRuntimeInputStep } from "./upload";

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

const cancelled = () => new ApiError(0, "Uppladdningen avbröts.", null, "upload_aborted");

export async function withRetry<T>(op: () => Promise<T>, opts: RetryOptions): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    // A cancel between attempts, or before the first, sends nothing more.
    if (opts.signal?.aborted) throw cancelled();
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
    const cancel = () => finish(cancelled());
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
  /** The run's speaker-label choice; only when the contract makes it selectable. */
  speakerLabels?: boolean;
  /** Every file is uploaded, and this is the run request Eneo is about to be asked. */
  onStarting?: (request: RunRequest) => void | Promise<void>;
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

  const body: Json = { expected_flow_version: contract.published_flow_version };
  if (fileIds.length > 0) body.step_inputs = { [stepId!]: { file_ids: fileIds } };
  if (Object.keys(params.inputPayload).length > 0) body.input_payload_json = params.inputPayload;
  if (params.speakerLabels !== undefined) body.speaker_labels = params.speakerLabels;
  const key =
    params.idempotencyKey ??
    (await deriveRunIdempotencyKey({
      flowId,
      expectedFlowVersion: contract.published_flow_version,
      body,
    }));
  await params.onStarting?.({ body, idempotencyKey: key });
  return withRetry(() => deps.startRun(flowId, body, key, params.signal), params);
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
  if (!recording) throw new Error(NOT_ON_DEVICE);
  // Set once Eneo is asked for the run; until it answers, the run may exist.
  let asked = recording.submission ?? null;
  let run: FlowRunPublic;
  try {
    if (asked) {
      // An earlier send never heard Eneo's answer: the same request gets the run it made.
      const request = asked;
      await params.onStarting?.(request);
      run = await withRetry(
        () => (deps?.startRun ?? startRun)(params.flowId, request.body, request.idempotencyKey, params.signal),
        params,
      );
    } else {
      const files = await store.readParts(id);
      if (files.length === 0) throw new Error("Inspelningen innehåller inget ljud.");
      await store.setState(id, "uploading");
      run = await submitRun(
        {
          ...params,
          idempotencyKey: `flow-run:recording:${id}`,
          files: files.map((file) => ({ ...file, fileId: recording.parts[file.index].fileId })),
          onUploaded: (index, fileId) => store.setPartFileId(id, files[index].index, fileId),
          onStarting: async (request) => {
            await store.startSubmission(id, request);
            asked = request;
            await params.onStarting?.(request);
          },
        },
        deps,
      );
    }
  } catch (error) {
    // The recording's key already made a run, from another request: it is
    // sent. The copy is left as it is (another tab may have deleted it).
    if (error instanceof ApiError && error.code === "flow_run_idempotency_conflict") {
      throw new Error(ALREADY_SENT);
    }
    if (!asked) {
      // Eneo was not asked: what was uploaded stays for the next send.
      await store.setState(id, "stopped");
    } else if (error instanceof ApiError && error.status >= 400 && !isRetryable(error)) {
      // Eneo refused the run, so none was made; its uploads may be what it refused.
      await store.clearFileIds(id);
      await store.setState(id, "stopped");
    }
    // Otherwise the run may exist: the recording stays "uploaded" with its request.
    throw error;
  }
  // Eneo has the run; tidying up the local copy must not turn it into a failure.
  await store.accept(id, run.id).catch(() => undefined);
  return run;
}

const START_AGAIN = "Starta en ny körning med samma ljud och uppgifter.";

// Why Eneo would not continue a failed run, and whether a new run with the same audio is the way on.
const RETRY_REFUSALS: Record<string, [message: string, startAgain: boolean]> = {
  flow_run_retry_source_version_stale: [
    `Flödet har ändrats sedan körningen och kan inte fortsätta där den stannade. ${START_AGAIN}`,
    true,
  ],
  flow_run_retry_nothing_to_reuse: [
    `Inget steg hann bli klart, så det finns inget att fortsätta från. ${START_AGAIN}`,
    true,
  ],
  flow_run_retry_prefix_unsupported: [
    `Det som blev klart kan inte återanvändas, så en ny körning gör om alla steg. ${START_AGAIN}`,
    true,
  ],
  flow_run_retry_source_not_failed: [`Bara en misslyckad körning kan fortsätta där den stannade. ${START_AGAIN}`, true],
  flow_run_access_denied: ["Bara den som startade körningen kan fortsätta den.", false],
  flow_run_concurrency_limit_reached: ["För många körningar pågår just nu. Försök igen om en stund.", false],
  not_found: ["Körningen finns inte längre och kan inte fortsätta.", false],
};

export type RetryOutcome =
  | { kind: "started"; run: FlowRunPublic }
  | { kind: "refused"; message: string; startAgain: boolean };

/**
 * "Försök igen": Eneo continues the failed run from its first unfinished step
 * in a child run. The key names the failure, so a second press or a lost
 * response returns the same child. A refusal says why in Swedish; the
 * network and the server's own trouble keep the answer "try again later".
 */
export async function retryFailedRun(
  flowId: string,
  failedRunId: string,
  retry: typeof retryFlowRunFromFailedStep = retryFlowRunFromFailedStep,
): Promise<RetryOutcome> {
  try {
    const { run } = await retry(flowId, failedRunId, `flow-run-retry:${failedRunId}`);
    return { kind: "started", run };
  } catch (error) {
    if (error instanceof ApiError) {
      const known = error.code ? RETRY_REFUSALS[error.code] : undefined;
      if (known) return { kind: "refused", message: known[0], startAgain: known[1] };
      // Only the refusals above say a new run with the same input is the way on; another may be about
      // the input itself or who may run the flow, which the same input cannot answer.
      if (error.status >= 400 && error.status < 500 && error.status !== 408) {
        return { kind: "refused", message: "Körningen kunde inte fortsätta där den stannade.", startAgain: false };
      }
    }
    return { kind: "refused", message: friendlyError(error), startAgain: false };
  }
}

const INPUT_CHANGED =
  "Flödet har ändrats sedan körningen och tar nu emot andra uppgifter eller filer. Gör en ny inspelning eller välj filen på nytt.";

/**
 * A new run with the failed run's audio, already in Eneo, and its details,
 * against `contract`: the way on when Eneo cannot continue the run (the flow
 * changed since, or nothing finished) and after a cancelled run. Its key names
 * the source, apart from the retry's, since the source was keyed on this same
 * body. When the flow now takes its input at another step, fewer files or a
 * detail the run lacks, the input needs another look: `review` says so. Null
 * when the run has no audio to start again with.
 */
export function startAgainRequest(
  failed: Pick<FlowRunPublic, "id" | "input_payload_json">,
  steps: readonly FlowRunStep[],
  contract: RunContract,
): RunRequest | { review: string } | null {
  const inputStep = [...steps]
    .sort((a, b) => (a.step_order ?? 0) - (b.step_order ?? 0))
    .find((step) => Array.isArray(step.runtime_input_file_ids) && step.runtime_input_file_ids.length > 0);
  const fileIds = (inputStep?.runtime_input_file_ids as unknown[] | undefined)?.filter(
    (id): id is string => typeof id === "string",
  );
  if (!inputStep || !fileIds?.length) return null;
  const step = selectRuntimeInputStep(contract);
  const payload = failed.input_payload_json ?? {};
  const fits =
    step?.step_id === inputStep.step_id &&
    fileIds.length <= (step.max_files ?? Infinity) &&
    (contract.form_fields ?? []).every((field) => !field.required || payload[field.name] != null);
  if (!step || !fits) return { review: INPUT_CHANGED };
  const body: Json = {
    expected_flow_version: contract.published_flow_version,
    step_inputs: { [step.step_id]: { file_ids: fileIds } },
  };
  if (Object.keys(payload).length > 0) body.input_payload_json = payload;
  return { body, idempotencyKey: `flow-run-again:${failed.id}` };
}

export type StartAgainOutcome =
  | { kind: "started"; run: FlowRunPublic; contract: RunContract }
  | { kind: "review"; message: string; contract: RunContract };

/**
 * "Starta en ny körning", against the flow as it is published now, for as
 * long as the page that asked lives: a signal that ends before, during or just
 * after a request gives null, so the page sends nothing more and neither
 * shows nor follows a run. Null too when there is no audio to start again with.
 */
export async function startAgain(
  flowId: string,
  failed: Pick<FlowRunPublic, "id" | "input_payload_json">,
  steps: readonly FlowRunStep[],
  opts: RetryOptions,
  deps: { getContract: typeof getRunContract } & Pick<SubmitDeps, "startRun"> = {
    getContract: getRunContract,
    startRun,
  },
): Promise<StartAgainOutcome | null> {
  try {
    // A flow published again since the run takes the new run only at its current version.
    const contract = await withRetry(() => deps.getContract(flowId), opts);
    if (opts.signal?.aborted) return null;
    const request = startAgainRequest(failed, steps, contract);
    if (!request) return null;
    if ("review" in request) return { kind: "review", message: request.review, contract };
    const run = await withRetry(
      () => deps.startRun(flowId, request.body, request.idempotencyKey, opts.signal),
      opts,
    );
    return opts.signal?.aborted ? null : { kind: "started", run, contract };
  } catch (error) {
    if (opts.signal?.aborted) return null;
    throw error;
  }
}
