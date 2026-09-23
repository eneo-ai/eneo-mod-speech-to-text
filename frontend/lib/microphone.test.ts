import assert from "node:assert/strict";
import test from "node:test";

import { audioConstraints, preferredMicrophone, setPreferredMicrophone } from "./microphone";

test("the chosen microphone is remembered per browser and asked for without failing when it is gone", () => {
  const data: Record<string, string> = {};
  const storage = { getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => void (data[key] = value) };
  assert.equal(preferredMicrophone(storage), null);
  assert.deepEqual(audioConstraints(preferredMicrophone(storage), { channelCount: 1 }), { channelCount: 1 }, "no choice: the browser's default");

  setPreferredMicrophone(storage, "usb-mic");
  assert.equal(preferredMicrophone(storage), "usb-mic");
  assert.deepEqual(
    audioConstraints("usb-mic", { channelCount: 1 }),
    { channelCount: 1, deviceId: { ideal: "usb-mic" } },
    "ideal, never exact, and the recorder's mono kept",
  );

  const blocked = {
    getItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
  };
  assert.equal(preferredMicrophone(blocked), null);
  setPreferredMicrophone(blocked, "usb-mic");
});
