import assert from "node:assert/strict";
import test from "node:test";

import { getRunContract, type RunContract, type RunContractStepInput } from "./api";
import { loginState } from "./login-state";
import { UPLOAD_ENVELOPE_BYTES, limitedToModule } from "./upload-limit";

const MiB = 1024 * 1024;
const step = (extra: Partial<RunContractStepInput>): RunContractStepInput => ({ step_id: "s", input_format: "audio", ...extra });
const contract = (...steps: RunContractStepInput[]): RunContract => ({ flow_id: "f", published_flow_version: 1, steps_requiring_input: steps });
const limits = (c: RunContract) => c.steps_requiring_input!.map((s) => s.max_file_size_bytes);

test("a file step takes no more than the module does, less the envelope the request puts round the file", () => {
  const cap = 100 * MiB;
  assert.deepEqual(limits(limitedToModule(contract(step({ max_file_size_bytes: 500 * MiB })), cap)), [cap - UPLOAD_ENVELOPE_BYTES]);
  assert.deepEqual(limits(limitedToModule(contract(step({})), cap)), [cap - UPLOAD_ENVELOPE_BYTES], "a flow that names no limit has the module's");
});

test("the flow's own smaller limit stays, and so does a step that takes no file", () => {
  const cap = 100 * MiB;
  const clamped = limitedToModule(contract(step({ max_file_size_bytes: 50 * MiB }), step({ step_id: "t", input_format: "text", max_file_size_bytes: 500 * MiB })), cap);
  assert.deepEqual(limits(clamped), [50 * MiB, 500 * MiB]);
  assert.equal(clamped.steps_requiring_input![1].max_file_size_bytes, 500 * MiB, "a text step has no file for the cap to be about");
});

test("every kind of file input is held to it", () => {
  const cap = MiB;
  for (const input_format of ["audio", "document", "file", "image"]) {
    assert.deepEqual(limits(limitedToModule(contract(step({ input_format, max_file_size_bytes: 9 * MiB })), cap)), [cap - UPLOAD_ENVELOPE_BYTES], input_format);
  }
});

test("without a limit from the module the contract is Eneo's as it came", () => {
  const eneos = contract(step({ max_file_size_bytes: 500 * MiB }));
  assert.equal(limitedToModule(eneos, null), eneos);
  assert.equal(limitedToModule({ flow_id: "f", published_flow_version: 1 }, MiB).steps_requiring_input, undefined);
});

test("the contract a page reads is already held to what its login's status said the module takes", async (t) => {
  const eneos = contract(step({ max_file_size_bytes: 500 * MiB }));
  const browserFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(eneos), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = browserFetch;
  });

  assert.deepEqual(limits(await getRunContract("f")), [500 * MiB], "nothing is known yet");
  loginState.observe({ authenticated: true, user: { id: "u", email: "a@b.se" }, max_upload_bytes: 100 * MiB });
  assert.equal(loginState.maxUploadBytes, 100 * MiB);

  assert.deepEqual(limits(await getRunContract("f")), [100 * MiB - UPLOAD_ENVELOPE_BYTES]);
});
