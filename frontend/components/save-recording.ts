import { useState } from "react";
import { downloadBlob } from "@/lib/download";
import { NOT_ON_DEVICE, recordingStore, type RecordingStore } from "@/lib/recording-store";

/** "Spara som fil": the recording's file at `nth` (its parts with audio, in order) as a download, read alone. */
export async function saveRecordingFile(
  recordingId: string,
  nth = 0,
  openStore: () => Promise<Pick<RecordingStore, "readFile">> = recordingStore,
): Promise<void> {
  const file = await (await openStore()).readFile(recordingId, nth);
  if (!file) throw new Error(NOT_ON_DEVICE);
  downloadBlob(file.blob, file.filename);
}

/**
 * "Spara som fil", one file to a press: a browser starts one download for a press without asking, and may block the
 * ones after it. A recording of several files says how many before the first, and which comes next after it. `files`
 * is the recording's own count (filesIn), so the label is the same at every first paint. `save` is false when it failed.
 */
export function useSaveRecording(recordingId: string, files: number) {
  const [next, setNext] = useState(0);
  const at = next < files ? next : 0;
  const label = files > 1 ? (at === 0 ? `Spara som ${files} filer` : `Spara fil ${at + 1} av ${files}`) : "Spara som fil";
  async function save(): Promise<boolean> {
    try {
      await saveRecordingFile(recordingId, at);
      setNext(at + 1);
      return true;
    } catch {
      return false;
    }
  }
  return { label, save };
}
