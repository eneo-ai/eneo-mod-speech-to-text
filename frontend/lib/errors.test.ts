import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "./api";
import { unavailableCopy } from "../components/flow/FlowPageStates";
import { errorAdvice, friendlyError } from "./errors";

const eneo = (status: number, code: string | undefined, message: string) =>
  new ApiError(status, message, { code, message }, code);

// Words of Eneo's English messages that must never reach the page.
const ENGLISH = /\b(the|flow|step|snapshot|republish|before|running|missing|schema|request|error)\b/i;

test("a flow whose Eneo snapshot is outdated says, in Swedish, that its owner must republish it", (t) => {
  t.mock.method(console, "warn", () => undefined);
  const error = eneo(
    409,
    "flow_assistant_snapshot_republish_required",
    "Step 1 (Transkribera ljud): Assistant snapshot is missing or uses an unsupported schema_version. Republish the flow before running it.",
  );
  assert.equal(friendlyError(error), "Flödet behöver publiceras om av den som ansvarar för det innan det kan användas.");
});

test("Eneo's English message never reaches the page, whatever the code", (t) => {
  t.mock.method(console, "warn", () => undefined);
  for (const error of [
    eneo(422, "flow_something_new", "Something new went wrong in the flow."),
    eneo(400, undefined, "Bad request: the request body is invalid."),
    eneo(403, "forbidden", "You do not have access to this flow."),
    eneo(401, "invalid_api_key", "The API key is invalid."),
    eneo(500, "internal_error", "Internal server error."),
  ]) {
    const text = friendlyError(error);
    assert.doesNotMatch(text, ENGLISH, `${error.code}: ${text}`);
    assert.ok(!text.includes(error.message), "not the raw message");
  }
});

test("Försök igen is offered only where trying again can help, and an owner's fix sends the user elsewhere", (t) => {
  t.mock.method(console, "warn", () => undefined);
  const republish = errorAdvice(eneo(409, "flow_assistant_snapshot_republish_required", "Republish the flow."));
  assert.deepEqual([republish.retry, republish.ownerMustFix], [false, true]);
  for (const code of ["flow_definition_schema_version_unsupported", "flow_published_form_schema_invalid", "flow_not_published"]) {
    assert.deepEqual([errorAdvice(eneo(409, code, "x")).retry, errorAdvice(eneo(409, code, "x")).ownerMustFix], [false, true], code);
  }
  const retries: unknown[] = [
    eneo(503, undefined, "Service Unavailable"),
    eneo(500, "internal_error", "Internal server error."),
    eneo(429, "flow_run_concurrency_limit_reached", "Too many runs."),
    eneo(502, "upstream_unreachable", "Eneo could not be reached."),
    new ApiError(422, "Unprocessable", { code: "flow_new", retryable: true }, "flow_new"),
    new TypeError("Failed to fetch"),
  ];
  for (const error of retries) assert.equal(errorAdvice(error).retry, true, String(error));
  for (const error of [
    eneo(422, "flow_input_invalid_date", "Invalid date."),
    eneo(422, "flow_something_new", "New."),
    eneo(403, "forbidden", "Forbidden."),
    eneo(413, "file_too_large", "Too large."),
  ]) {
    assert.deepEqual([errorAdvice(error).retry, errorAdvice(error).ownerMustFix], [false, false], String(error.code));
  }
});

test("Eneo's own words go to the console once, for support", (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const error = eneo(409, "flow_assistant_snapshot_republish_required", "Assistant snapshot is missing.");
  friendlyError(error);
  friendlyError(error);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /409 \(flow_assistant_snapshot_republish_required\): Assistant snapshot is missing\./);
});

test("this app's own upload errors keep their Swedish words, and trying again can help", () => {
  const upload = new ApiError(0, "Nätverksfel vid uppladdning. Kontrollera anslutningen och försök igen.", null, "network_error");
  assert.deepEqual(errorAdvice(upload), {
    message: "Nätverksfel vid uppladdning. Kontrollera anslutningen och försök igen.",
    retry: true,
    ownerMustFix: false,
  });
});

test("a flow that cannot be opened says why in Swedish, and offers Försök igen only where it can help", (t) => {
  t.mock.method(console, "warn", () => undefined);
  const republish = unavailableCopy(
    eneo(409, "flow_assistant_snapshot_republish_required", "Assistant snapshot is missing. Republish the flow before running it."),
  );
  assert.deepEqual(republish, {
    title: "Flödet kan inte användas just nu.",
    detail: "Flödet behöver publiceras om av den som ansvarar för det innan det kan användas.",
    retry: false,
  });
  assert.equal(unavailableCopy(eneo(503, undefined, "Service Unavailable")).retry, true);
  assert.equal(unavailableCopy(eneo(404, "not_found", "Flow not found.")).title, "Flödet är inte längre tillgängligt.");
});
