import { NOT_ON_DEVICE, recordingStore, type RecordingStore } from "@/lib/recording-store";

// ponytail: a generous delay before revoking, since a large download may start late.
const REVOKE_AFTER_MS = 60_000;

/** "Spara som fil": one download per part, in order. */
export async function saveRecordingAsFiles(
  recordingId: string,
  openStore: () => Promise<Pick<RecordingStore, "readParts">> = recordingStore,
): Promise<void> {
  const store = await openStore();
  const files = await store.readParts(recordingId);
  if (files.length === 0) throw new Error(NOT_ON_DEVICE);
  for (const file of files) {
    const url = URL.createObjectURL(file.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  }
}
