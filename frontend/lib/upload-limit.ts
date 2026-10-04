import type { RunContract } from "./api";
import { isRuntimeFileInput } from "./upload";

/**
 * What the request that carries a file adds to it: the multipart boundary lines and the part's headers, a file name
 * included. The module's limit is on the whole request, so the largest file is a little under it.
 */
export const UPLOAD_ENVELOPE_BYTES = 4096;

/**
 * The run contract with every file step's size limit held to what the module takes (`max_upload_bytes` of its status
 * answer): a file above it is refused by the module while it is still being sent, and a proxy in front may answer
 * that with a 502. Held here, once, to the contract's one reader, the page never offers, records into or sends a file
 * the module would refuse, and says so in the words it uses for a flow's own limit. Without a limit from the module the
 * contract is Eneo's as it came.
 */
export function limitedToModule(contract: RunContract, maxUploadBytes: number | null): RunContract {
  if (maxUploadBytes === null || !contract.steps_requiring_input) return contract;
  const largestFile = Math.max(0, maxUploadBytes - UPLOAD_ENVELOPE_BYTES);
  return {
    ...contract,
    steps_requiring_input: contract.steps_requiring_input.map((step) =>
      isRuntimeFileInput(step.input_format) ? { ...step, max_file_size_bytes: Math.min(step.max_file_size_bytes ?? Infinity, largestFile) } : step,
    ),
  };
}
