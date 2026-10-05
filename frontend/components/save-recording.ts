import { downloadBlob } from "@/lib/download";
import { NOT_ON_DEVICE, recordingStore, type RecordingStore } from "@/lib/recording-store";

/** "Spara som fil": one download per part, in order. */
export async function saveRecordingAsFiles(
  recordingId: string,
  openStore: () => Promise<Pick<RecordingStore, "readParts">> = recordingStore,
): Promise<void> {
  const store = await openStore();
  const files = await store.readParts(recordingId);
  if (files.length === 0) throw new Error(NOT_ON_DEVICE);
  for (const file of files) downloadBlob(file.blob, file.filename);
}
