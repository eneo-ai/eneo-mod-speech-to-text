import assert from "node:assert/strict";
import test from "node:test";

import { audioConstraints, microphoneChoices, preferredMicrophone, setPreferredMicrophone } from "./microphone";

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

const input = (deviceId: string, label: string, groupId = deviceId) =>
  ({ kind: "audioinput", deviceId, label, groupId }) as MediaDeviceInfo;

test("Standard names the microphone the system uses when the browser says which, and each device by its name", () => {
  const chrome = [
    input("default", "Standard – MacBook Pro-mikrofon (Built-in)", "g1"),
    input("communications", "Kommunikation – Jabra Speak 510", "g2"),
    input("mac", "MacBook Pro-mikrofon (Built-in)", "g1"),
    input("usb", "Jabra Speak 510", "g2"),
  ];
  assert.deepEqual(microphoneChoices(chrome, null).choices, [
    { value: "", label: "Standard (MacBook Pro-mikrofon (Built-in))" },
    { value: "mac", label: "MacBook Pro-mikrofon (Built-in)" },
    { value: "usb", label: "Jabra Speak 510" },
  ]);
  // Firefox and Safari name no default; before permission nothing is named.
  assert.deepEqual(microphoneChoices([input("a", "USB-mikrofon")], null).choices[0], { value: "", label: "Standard" });
  assert.deepEqual(microphoneChoices([input("", "", "")], null).choices, [{ value: "", label: "Standard" }]);
});

test("a remembered microphone that is gone falls back to Standard, with a note once the devices are known", () => {
  const devices = [input("default", "Default - Headset", "g"), input("headset", "Headset", "g")];
  assert.deepEqual(microphoneChoices(devices, "headset"), {
    choices: [
      { value: "", label: "Standard (Headset)" },
      { value: "headset", label: "Headset" },
    ],
    value: "headset",
    missing: false,
  });
  assert.deepEqual(
    { value: microphoneChoices(devices, "bluetooth").value, missing: microphoneChoices(devices, "bluetooth").missing },
    { value: "", missing: true },
  );
  assert.equal(microphoneChoices([], "bluetooth").missing, false, "before permission nothing is known to be missing");
});
