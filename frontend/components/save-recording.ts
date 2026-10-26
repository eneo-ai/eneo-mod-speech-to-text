import { useRef, useState } from "react";
import { downloadFiles } from "@/lib/download";
import { NOT_ON_DEVICE, recordingStore, type RecordingStore } from "@/lib/recording-store";

/** "Spara ljudfil": the recording in one download, every part with audio that survived, read when it is pressed. */
export async function saveRecording(
  recordingId: string,
  openStore: () => Promise<Pick<RecordingStore, "readParts">> = recordingStore,
): Promise<void> {
  // A failed database read throws, and is said as one; a recording whose audio is gone is said as that.
  const files = await (await openStore()).readParts(recordingId);
  if (files.length === 0) throw new Error(NOT_ON_DEVICE);
  await downloadFiles(files);
}

/** "Spara ljudfil" for a recording of `files` files: one press saves them all, several together in a zip. */
export function saveLabel(files: number): string {
  return files <= 1 ? "Spara ljudfil" : `Spara ${files} ljudfiler (zip)`;
}

/**
 * "Spara ljudfil" for a recording of `files` files (filesIn, so the label is the same at every first paint). `busy`
 * while the files are read; a press meanwhile adds nothing. `save` is false when it failed.
 */
export function useSaveRecording(recordingId: string, files: number) {
  const [busy, setBusy] = useState(false);
  // Set at once, so a second press in the same moment finds the first one saving.
  const saving = useRef(false);
  async function save(): Promise<boolean> {
    if (saving.current) return true;
    saving.current = true;
    setBusy(true);
    try {
      await saveRecording(recordingId);
      return true;
    } catch {
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return { label: saveLabel(files), save, busy };
}
