import { useRef, useState } from "react";
import { downloadBlob } from "@/lib/download";
import { NOT_ON_DEVICE, recordingStore, type RecordingStore } from "@/lib/recording-store";

/** "Spara ljudfil": the recording's file at `nth` (its parts with audio, in order) as a download, read alone. */
export async function saveRecordingFile(
  recordingId: string,
  nth = 0,
  openStore: () => Promise<Pick<RecordingStore, "readFile">> = recordingStore,
  files = nth + 1,
): Promise<number> {
  const store = await openStore();
  for (let at = nth; at < files; at += 1) {
    // A successful read with no surviving audio is a missing part, not a storage failure. Try the next part; a failed
    // database read throws and leaves the cursor where it was, so retry never skips audio that might still be there.
    const file = await store.readFile(recordingId, at);
    if (!file) continue;
    downloadBlob(file.blob, file.filename);
    return at + 1;
  }
  throw new Error(NOT_ON_DEVICE);
}

/** "Spara ljudfil" for a recording of `files` files whose next file to save is `at`: how many before the first, then which. */
export function saveLabel(files: number, at: number): string {
  if (files <= 1) return "Spara ljudfil";
  return at === 0 ? `Spara som ${files} ljudfiler` : `Spara ljudfil ${at + 1} av ${files}`;
}

/**
 * "Spara ljudfil", one file to a press: a browser starts one download for a press without asking, and may block the
 * ones after it. A recording of several files says how many before the first, and which comes next after it, once
 * that file is saved. `files` is the recording's own count (filesIn), so the label is the same at every first paint.
 * `busy` while a file is read; a press meanwhile adds nothing. `save` is false when it failed.
 */
export function useSaveRecording(recordingId: string, files: number) {
  const [next, setNext] = useState(0);
  const [busy, setBusy] = useState(false);
  // Set at once, so a second press in the same moment finds the first one saving.
  const saving = useRef(false);
  const at = next < files ? next : 0;
  const label = saveLabel(files, at);
  async function save(): Promise<boolean> {
    if (saving.current) return true;
    saving.current = true;
    setBusy(true);
    try {
      setNext(await saveRecordingFile(recordingId, at, recordingStore, files));
      return true;
    } catch {
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return { label, save, busy };
}
