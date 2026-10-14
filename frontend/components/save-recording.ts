import { useState } from "react";
import { downloadBlob } from "@/lib/download";
import { NOT_ON_DEVICE, recordingStore, type RecordingStore } from "@/lib/recording-store";

/** "Spara som fil": the recording's file at `nth` (its parts with audio, in order) as a download; says how many it has. */
export async function saveRecordingFile(
  recordingId: string,
  nth = 0,
  openStore: () => Promise<Pick<RecordingStore, "readParts">> = recordingStore,
): Promise<number> {
  const files = await (await openStore()).readParts(recordingId);
  const file = files[nth] ?? files[0];
  if (!file) throw new Error(NOT_ON_DEVICE);
  downloadBlob(file.blob, file.filename);
  return files.length;
}

/**
 * "Spara som fil", one file to a press: a browser starts one download for a press without asking, and may block the
 * ones after it. A recording of several files says how many before the first, and which comes next after it. `files`
 * is how many the page knows of; the device's own count holds once it has been read. `save` is false when it failed.
 */
export function useSaveRecording(recordingId: string, files: number) {
  const [{ next, total }, setProgress] = useState({ next: 0, total: files });
  const count = next === 0 ? files : total;
  const label = count > 1 ? (next === 0 ? `Spara som ${count} filer` : `Spara fil ${next + 1} av ${count}`) : "Spara som fil";
  async function save(): Promise<boolean> {
    try {
      const saved = await saveRecordingFile(recordingId, next);
      setProgress({ next: (next + 1) % saved, total: saved });
      return true;
    } catch {
      return false;
    }
  }
  return { label, save };
}
