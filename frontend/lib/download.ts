import { zipFiles, type NamedBlob } from "./zip";

/** The object URL outlives the click for as long as a large download may take to start. */
const REVOKE_AFTER_MS = 60_000;

/** Starts the download of `blob` as `filename`. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}

/**
 * Every file in one download: one file as it is, several as a zip named after the first without its part
 * ("inspelning-2026-10-26-1103-del-1.webm" gives "inspelning-2026-10-26-1103.zip").
 */
export async function downloadFiles(files: readonly NamedBlob[]): Promise<void> {
  if (files.length === 1) return downloadBlob(files[0].blob, files[0].filename);
  downloadBlob(await zipFiles(files), files[0].filename.replace(/(-del-\d+)?(\.[^.]*)?$/, ".zip"));
}
