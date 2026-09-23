"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Download, ExternalLink, MoreHorizontal, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { runArtifactUrl } from "@/lib/api";
import type { ResultFileView } from "@/lib/run-files";
import { cn } from "@/lib/utils";
import { CopyStatus, useCopy } from "./CopyButton";
import { FILE_ICONS, OpenFile } from "./ResultFiles";

export const RESULT_PROSE =
  "prose max-w-none [&>:first-child]:mt-0 prose-headings:tracking-tight prose-h1:text-[22px] prose-h2:text-[20px] prose-h3:text-[17px] prose-p:text-[16px] prose-p:leading-relaxed prose-li:text-[16px] prose-a:underline-offset-4 prose-code:before:hidden prose-code:after:hidden";

/** Files larger than this are not read ahead for Dela; they download instead. */
const SHARE_LIMIT_BYTES = 25 * 1024 * 1024;

type Share = { kind: "file"; file: File } | { kind: "text" } | { kind: "link"; url: string };

/**
 * Dela through the device's own share sheet, where there is one: the file when
 * the device takes its type and its size is known and under the cap (read
 * ahead, since a share must start from the press itself, and the read stops
 * when the document leaves the page); otherwise the text, or the file's link.
 * Nothing when the browser has no share.
 */
function useShare(file: ResultFileView | null, url: string | null, text: string | null): Share | null {
  const [share, setShare] = useState<Share | null>(null);
  useEffect(() => {
    if (typeof navigator === "undefined" || typeof navigator.share !== "function") return;
    const controller = new AbortController();
    const instead: Share | null = text ? { kind: "text" } : url ? { kind: "link", url: new URL(url, window.location.href).href } : null;
    const probe = file ? new File([""], file.name, { type: file.mimeType }) : null;
    const fileShareable =
      file && url && probe && file.sizeBytes !== null && file.sizeBytes <= SHARE_LIMIT_BYTES &&
      typeof navigator.canShare === "function" && navigator.canShare({ files: [probe] });
    if (fileShareable) {
      fetch(url, { signal: controller.signal })
        .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(String(response.status)))))
        .then((blob) => {
          if (!controller.signal.aborted) setShare({ kind: "file", file: new File([blob], file.name, { type: blob.type || file.mimeType }) });
        })
        .catch(() => {
          if (!controller.signal.aborted) setShare(instead);
        });
    } else {
      setShare(instead);
    }
    return () => controller.abort();
  }, [file, url, text]);
  return share;
}

async function runShare(share: Share, title: string, text: string | null): Promise<void> {
  try {
    await navigator.share(
      share.kind === "file" ? { files: [share.file], title } : share.kind === "link" ? { title, url: share.url } : { title, text: text ?? "" },
    );
  } catch {
    // Closing the share sheet is a choice, not an error; a refused share leaves the other actions.
  }
}

/**
 * What the flow produced, first on the page: the text as a readable page and
 * its file, with one filled action (the file's download, or copying the text
 * when there is no file) and never a second download of the same file.
 */
export function ResultDocument({
  flowId,
  runId,
  text,
  file,
  title,
}: {
  flowId: string;
  runId: string;
  /** The result's text, as markdown. */
  text: string | null;
  /** The file the flow made, the first one that can be fetched. */
  file: ResultFileView | null;
  /** What a share is called: the flow's name. */
  title: string;
}) {
  const download = file ? runArtifactUrl(flowId, runId, file.fileId) : null;
  const inline = file ? runArtifactUrl(flowId, runId, file.fileId, true) : null;
  const share = useShare(file, download, text);
  const [copyState, copy] = useCopy(text ?? "");
  const Icon = file ? FILE_ICONS[file.kind] : null;

  const primaryDownload = file && download && (
    <Button asChild>
      <a href={download} download>
        <Download data-icon="inline-start" aria-hidden />
        Ladda ner {file.typeLabel}
        <span className="sr-only">, {file.name}</span>
      </a>
    </Button>
  );
  const copyLabel = copyState === "copied" ? "Kopierat" : copyState === "failed" ? "Kunde inte kopiera" : null;

  return (
    <>
      {/* Narrower: above the document, the download first, opening the file beside it, the rest under Fler alternativ. */}
      <div className="flex flex-wrap items-center gap-2 lg:hidden">
        {primaryDownload}
        {file?.previewable && inline && (
          <Button asChild variant="outline">
            <a href={inline} target="_blank" rel="noopener noreferrer">
              <ExternalLink data-icon="inline-start" aria-hidden />
              Öppna {file.typeLabel}
              <span className="sr-only"> i en ny flik</span>
            </a>
          </Button>
        )}
        {text && !file && (
          <Button type="button" onClick={copy}>
            <Copy data-icon="inline-start" aria-hidden />
            {copyLabel ?? "Kopiera texten"}
          </Button>
        )}
        {((text && file) || share) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon" aria-label="Fler alternativ">
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {text && file && (
                <DropdownMenuItem onSelect={() => void copy()}>
                  <Copy aria-hidden />
                  Kopiera texten
                </DropdownMenuItem>
              )}
              {share && (
                <DropdownMenuItem onSelect={() => void runShare(share, title, text)}>
                  <Share2 aria-hidden />
                  Dela
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

    <section aria-label="Dokumentet" className="flex flex-col rounded-xl border bg-card">
      {/* From a laptop's width: Kopiera and the one download on the document's top edge. */}
      <div className="hidden items-center justify-end gap-1 border-b border-border px-4 py-2.5 lg:flex">
        {text && (
          <Button type="button" variant={file ? "ghost" : "default"} onClick={copy}>
            <Copy data-icon="inline-start" aria-hidden />
            {copyLabel ?? (file ? "Kopiera" : "Kopiera texten")}
            {!copyLabel && file && <span className="sr-only"> texten</span>}
          </Button>
        )}
        {primaryDownload}
      </div>

      {text && (
        <article className={cn(RESULT_PROSE, "px-5 py-6 md:px-10 md:py-9")}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </article>
      )}

      {/* The file, under Eneo's name: its type and size, and Öppna where the browser can show it. No second download. */}
      {file && Icon && (
        <div className={cn("flex items-center gap-3 px-5 py-3", text && "border-t border-border")}>
          <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
            <Icon className="size-[18px]" strokeWidth={2} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-medium leading-snug text-ink [overflow-wrap:anywhere]">{file.name}</p>
            <p className="text-[13px] text-ink-mute">{file.meta}</p>
          </div>
          {file.previewable && download && inline && (
            <div className="hidden lg:block">
              <OpenFile file={file} url={inline} download={download} variant="ghost" />
            </div>
          )}
        </div>
      )}
      <CopyStatus state={copyState} />
    </section>
    </>
  );
}
