import { recordingStore } from "@/lib/recording-store";

// ponytail: a generous delay before revoking, since a large download may start late.
const REVOKE_AFTER_MS = 60_000;

/** "Spara som fil": one download per part, in order. */
export async function saveRecordingAsFiles(recordingId: string): Promise<void> {
  const store = await recordingStore();
  for (const file of await store.readParts(recordingId)) {
    const url = URL.createObjectURL(file.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  }
}
