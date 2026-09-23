/**
 * A run's generated files as people see them: named after the flow and the
 * day (until Eneo names files itself, bead eneo-ewq1), with their type and
 * size in Swedish, and whether the browser's own viewer can show them.
 */

import type { ResultFile } from "./api";
import { formatBytes } from "./format";

export type FileKind = "pdf" | "word" | "spreadsheet" | "text" | "audio" | "image" | "other";

export interface ResultFileView {
  fileId: string;
  /** "Nämndmöte till rapport 2026-09-23" */
  name: string;
  /** The name a download gets, with its extension. */
  downloadName: string;
  kind: FileKind;
  /** "PDF, 13,3 kB", or why the file cannot be fetched. */
  meta: string;
  available: boolean;
  /** A PDF opens in the browser's own viewer. */
  previewable: boolean;
}

const KNOWN: [ext: string, mime: string, kind: FileKind, label: string][] = [
  ["pdf", "application/pdf", "pdf", "PDF"],
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "word", "Word"],
  ["doc", "application/msword", "word", "Word"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "spreadsheet", "Excel"],
  ["csv", "text/csv", "spreadsheet", "CSV"],
  ["txt", "text/plain", "text", "Text"],
  ["md", "text/markdown", "text", "Text"],
  ["json", "application/json", "text", "JSON"],
];

function fileType(file: ResultFile): { ext: string; kind: FileKind; label: string } {
  const mime = (file.mimetype ?? "").split(";")[0].trim().toLowerCase();
  const ext = /\.([a-z0-9]{1,8})$/i.exec(file.name ?? "")?.[1].toLowerCase() ?? "";
  const known = KNOWN.find(([, m]) => m === mime) ?? KNOWN.find(([e]) => e === ext);
  if (known) return { ext: known[0], kind: known[2], label: known[3] };
  if (mime.startsWith("audio/")) return { ext, kind: "audio", label: "Ljud" };
  if (mime.startsWith("image/")) return { ext, kind: "image", label: "Bild" };
  return { ext, kind: "other", label: ext ? ext.toUpperCase() : "Fil" };
}

const two = (n: number) => String(n).padStart(2, "0");

/** The flow's name without characters a file name cannot carry, and the run's day. */
export function readableBaseName(flowName: string, createdAt?: string): string {
  const name = flowName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim() || "Dokument";
  const date = createdAt ? new Date(createdAt) : null;
  if (!date || Number.isNaN(date.getTime())) return name;
  return `${name} ${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

export function resultFileViews(
  files: readonly ResultFile[],
  flowName: string,
  createdAt?: string,
): ResultFileView[] {
  const base = readableBaseName(flowName, createdAt);
  const taken = new Map<string, number>();
  return files.map((file) => {
    const type = fileType(file);
    const extension = type.ext ? `.${type.ext}` : "";
    const count = (taken.get(extension) ?? 0) + 1;
    taken.set(extension, count);
    const name = count === 1 ? base : `${base} (${count})`;
    const available = file.availability == null || file.availability === "available";
    return {
      fileId: file.file_id,
      name,
      downloadName: `${name}${extension}`,
      kind: type.kind,
      meta: available
        ? [type.label, file.size != null ? formatBytes(file.size) : null].filter(Boolean).join(", ")
        : file.availability === "content_purged"
          ? "Filen har tagits bort."
          : "Filen går inte att hämta.",
      available,
      previewable: available && type.kind === "pdf",
    };
  });
}
