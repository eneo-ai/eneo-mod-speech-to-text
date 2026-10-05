import assert from "node:assert/strict";
import test from "node:test";

import { RECORDING_QUERY_PARAM, sendRecordingAddress } from "./flow-address";

test("the address that sends a stored recording carries its id under the name the flow page reads", () => {
  const url = new URL(sendRecordingAddress("flow-1", "rec-7"), "http://module.test");
  assert.equal(url.pathname, "/flows/flow-1");
  assert.equal(url.searchParams.get(RECORDING_QUERY_PARAM), "rec-7");
});
