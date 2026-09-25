/**
 * A run's generated files as people see them: the name Eneo gave each file
 * (eneo-ewq1 makes it readable at the source), its type and size in Swedish,
 * and whether the browser's own viewer can show it. The page names nothing.
 */

import type { FlowRunStep, ResultFile } from "./api";
import { formatBytes } from "./format";

export type FileKind = "pdf" | "word" | "spreadsheet" | "text" | "audio" | "image" | "other";

export interface ResultFileView {
  fileId: string;
  /** Eneo's name for the file, as it downloads. */
  name: string;
  kind: FileKind;
  /** "PDF", "Word": the type in words, as in "Ladda ner PDF". */
  typeLabel: string;
  /** The media type the file is shared with. */
  mimeType: string;
  sizeBytes: number | null;
  /** "PDF, 13,3 kB", or why the file cannot be fetched. */
  meta: string;
  available: boolean;
  /** A PDF opens in the browser's own viewer. */
  previewable: boolean;
  /** The step that made the file, when Eneo names it. */
  stepId: string | null;
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

function fileType(file: ResultFile): { kind: FileKind; label: string; mime: string } {
  const mime = (file.mimetype ?? "").split(";")[0].trim().toLowerCase();
  const ext = /\.([a-z0-9]{1,8})$/i.exec(file.name ?? "")?.[1].toLowerCase() ?? "";
  const known = KNOWN.find(([, m]) => m === mime) ?? KNOWN.find(([e]) => e === ext);
  if (known) return { kind: known[2], label: known[3], mime: mime || known[1] };
  if (mime.startsWith("audio/")) return { kind: "audio", label: "Ljud", mime };
  if (mime.startsWith("image/")) return { kind: "image", label: "Bild", mime };
  return { kind: "other", label: ext ? ext.toUpperCase() : "Fil", mime: mime || "application/octet-stream" };
}

export function resultFileViews(files: readonly ResultFile[]): ResultFileView[] {
  return files.map((file) => {
    const type = fileType(file);
    const available = file.availability == null || file.availability === "available";
    return {
      fileId: file.file_id,
      name: file.name?.trim() || "Fil",
      kind: type.kind,
      typeLabel: type.label,
      mimeType: type.mime,
      sizeBytes: file.size ?? null,
      meta: available
        ? [type.label, file.size != null ? formatBytes(file.size) : null].filter(Boolean).join(", ")
        : file.availability === "content_purged"
          ? "Filen har tagits bort."
          : "Filen går inte att hämta.",
      available,
      previewable: available && type.kind === "pdf",
      stepId: file.step_id ?? null,
    };
  });
}

/**
 * The transcript .txt the page itself creates, named the way Eneo names a
 * run's documents: the flow's name and the run's day in UTC.
 */
export function transcriptFileName(flowName: string, createdAt?: string): string {
  const name = flowName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  const created = createdAt ? new Date(createdAt) : null;
  const day = created && !Number.isNaN(created.getTime()) ? created.toISOString().slice(0, 10) : "";
  const base = [name, day].filter(Boolean).join(" ");
  return base ? `${base} transkript.txt` : "transkript.txt";
}

/**
 * What a generated document says, as Markdown: the text its own step wrote,
 * which Eneo lays out in the file (a model's answer, or text a step renders
 * verbatim), never what the step read. Null where that text is not the
 * document: laid out from structured fields, only the start of a longer text,
 * a filled template's list of its fields, or no step named.
 */
export function fileText(file: ResultFileView, steps: readonly FlowRunStep[]): string | null {
  const step = file.stepId ? steps.find((s) => s.step_id === file.stepId) : undefined;
  const output = step?.output_payload_json as { text?: unknown; structured?: unknown; text_overflow?: unknown } | null | undefined;
  const mode = (step?.model_parameters_json as { mode?: unknown } | null | undefined)?.mode;
  if (!output || typeof output.text !== "string" || "structured" in output || output.text_overflow || mode === "template_fill") {
    return null;
  }
  return output.text.trim() ? output.text : null;
}
