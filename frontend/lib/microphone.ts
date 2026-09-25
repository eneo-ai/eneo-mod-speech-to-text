/**
 * The microphone this browser records with. The choice is remembered per
 * browser and asked for as `ideal`, so an unplugged device falls back to the
 * default instead of failing the recording.
 */

import type { KeyValueStorage } from "./flow-session";

const KEY = "tal-till-text:microphone";

export function preferredMicrophone(storage: KeyValueStorage | null | undefined): string | null {
  try {
    return storage?.getItem(KEY) || null;
  } catch {
    return null;
  }
}

export function setPreferredMicrophone(storage: KeyValueStorage | null | undefined, deviceId: string): void {
  try {
    storage?.setItem(KEY, deviceId);
  } catch {
    // Blocked storage: the default microphone is used next time.
  }
}

/** The recorder's own constraints (mono speech) with the chosen microphone, if any. */
export function audioConstraints(
  deviceId: string | null,
  base: MediaTrackConstraints = {},
): MediaTrackConstraints {
  return deviceId ? { ...base, deviceId: { ideal: deviceId } } : base;
}

// Chrome lists the system default and Windows' communications device as extra
// entries for a real input; they would show every microphone twice.
const ALIASES = new Set(["default", "communications"]);

/** The audio inputs the browser lists; until the microphone is allowed their names are empty. */
export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput");
  } catch {
    return [];
  }
}

export interface MicrophoneChoice {
  /** The device's id; "" is Standard, whatever the system uses. */
  value: string;
  label: string;
}

/**
 * The picker: "Standard" first, naming the microphone the system uses when
 * the browser says which (Chrome's "default" entry), then each microphone by
 * its name. A remembered microphone that is gone falls back to Standard, and
 * `missing` says so once the devices are known; until then the remembered one
 * is the choice, as recording asks for it.
 */
export function microphoneChoices(
  inputs: readonly MediaDeviceInfo[],
  preferred: string | null,
): { choices: MicrophoneChoice[]; value: string; missing: boolean } {
  const named = inputs.filter((device) => device.label && device.deviceId && !ALIASES.has(device.deviceId));
  const system = inputs.find((device) => device.deviceId === "default" && device.label);
  const systemName =
    system &&
    (named.find((device) => device.groupId && device.groupId === system.groupId)?.label ??
      system.label.replace(/^\s*(default|standard)\s*[-–—:]\s*/i, ""));
  const found = preferred !== null && named.some((device) => device.deviceId === preferred);
  const standard = { value: "", label: systemName ? `Standard (${systemName})` : "Standard" };
  // Before the browser names its microphones, the remembered one is what a test and a recording ask for.
  if (named.length === 0 && preferred !== null) {
    return { choices: [standard, { value: preferred, label: "Senast vald mikrofon" }], value: preferred, missing: false };
  }
  return {
    choices: [standard, ...named.map((device) => ({ value: device.deviceId, label: device.label }))],
    value: found ? preferred : "",
    missing: preferred !== null && named.length > 0 && !found,
  };
}
