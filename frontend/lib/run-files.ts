/**
 * A run's generated files as people see them: the name Eneo gave each file, its type and size in Swedish, and whether
 * the browser's own viewer can show it.
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

const two = (n: number) => String(n).padStart(2, "0");

/**
 * A .txt the page itself creates (the transcript, a text result): the flow's name, the run's day and time where the
 * person is ("2026-09-23 14.02", a full stop since Windows takes no colon in a file name), then what it is
 * ("transkribering").
 */
export function runFileName(flowName: string, createdAt?: string, what = ""): string {
  const name = flowName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  const d = createdAt ? new Date(createdAt) : null;
  const when =
    d && !Number.isNaN(d.getTime()) ? `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}` : "";
  return `${[name, when, what].filter(Boolean).join(" ") || "Resultat"}.txt`;
}

/** The transcript's .txt: "Nämndmöte 2026-09-23 14.02 transkribering.txt". */
export const transcriptFileName = (flowName: string, createdAt?: string) => runFileName(flowName, createdAt, "transkribering");

/**
 * What a generated document says, as Markdown: the text its own step wrote, only where Eneo lays that text out in
 * the file as prose (its runtime/output_formats: `render_document_output` for a PDF or Word step), never what the
 * step read. That is a model's answer (its parameters name the model) or the text a compose_text or render_verbatim
 * step lays out as it is; whole (no `text_overflow`), from no output contract (a `structured` value is laid out from
 * its fields) and not already a PDF (pdf.py keeps a text that starts with %PDF- as the file itself). Anything else,
 * a filled template or a step Eneo does not say how it made, is null.
 */
export function fileText(file: ResultFileView, steps: readonly FlowRunStep[]): string | null {
  const step = file.stepId ? steps.find((s) => s.step_id === file.stepId) : undefined;
  const output = step?.output_payload_json as { text?: unknown; structured?: unknown; text_overflow?: unknown } | null | undefined;
  const parameters = step?.model_parameters_json as { mode?: unknown; model_id?: unknown } | null | undefined;
  const laidOut =
    parameters?.mode === "compose_text" ||
    parameters?.mode === "render_verbatim" ||
    (parameters?.mode === undefined && parameters != null && "model_id" in parameters);
  if (!laidOut || !output || typeof output.text !== "string" || "structured" in output || output.text_overflow) return null;
  const pdfBytes = file.kind === "pdf" && output.text.trimStart().startsWith("%PDF-");
  return output.text.trim() && !pdfBytes ? output.text : null;
}
