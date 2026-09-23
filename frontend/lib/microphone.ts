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

export type MicrophonePermission = "granted" | "denied" | "prompt" | "unknown";

/** Whether the browser already lets the app use the microphone; never asks. */
export async function microphonePermission(): Promise<MicrophonePermission> {
  try {
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return status.state;
  } catch {
    // Firefox before 116 and some embedded browsers do not answer.
    return "unknown";
  }
}

// Chrome lists the system default and Windows' communications device as extra
// entries for a real input; they would show every microphone twice.
const ALIASES = new Set(["default", "communications"]);

/** The inputs the browser names; without permission it names none. */
export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(
      (device) =>
        device.kind === "audioinput" && device.label && device.deviceId && !ALIASES.has(device.deviceId),
    );
  } catch {
    return [];
  }
}
