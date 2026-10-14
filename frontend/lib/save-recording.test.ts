import assert from "node:assert/strict";
import test from "node:test";

import { NOT_ON_DEVICE } from "./recording-store";

test("Spara som fil on a recording that is gone from the device says so instead of doing nothing", async () => {
  const { saveRecordingFile } = await import("../components/save-recording");
  await assert.rejects(
    saveRecordingFile("gone", 0, async () => ({ readParts: async () => [] })),
    { message: NOT_ON_DEVICE },
  );
});
