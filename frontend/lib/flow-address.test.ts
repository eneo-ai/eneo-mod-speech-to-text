import assert from "node:assert/strict";
import test from "node:test";

import { CONTINUE_QUERY_PARAM, continueRecordingAddress, RECORDING_QUERY_PARAM, sendRecordingAddress } from "./flow-address";

test("the address that sends a stored recording carries its id under the name the flow page reads", () => {
  const url = new URL(sendRecordingAddress("flow-1", "rec-7"), "http://module.test");
  assert.equal(url.pathname, "/flows/flow-1");
  assert.equal(url.searchParams.get(RECORDING_QUERY_PARAM), "rec-7");
});

test("the address that records on in a cut-off recording carries its id under a name of its own, never as a send", () => {
  const url = new URL(continueRecordingAddress("flow-1", "rec-7"), "http://module.test");
  assert.equal(url.pathname, "/flows/flow-1");
  assert.equal(url.searchParams.get(CONTINUE_QUERY_PARAM), "rec-7");
  assert.equal(url.searchParams.get(RECORDING_QUERY_PARAM), null);
});
