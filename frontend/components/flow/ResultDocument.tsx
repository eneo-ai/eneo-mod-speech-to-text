"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, Copy, Download, ExternalLink, MoreHorizontal, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { runArtifactUrl } from "@/lib/api";
import type { ResultFileView } from "@/lib/run-files";
import { cn } from "@/lib/utils";
import { CopyStatus, useCopy } from "./CopyButton";
import { FILE_ICONS, OpenFile } from "./ResultFiles";

type MarkdownNode = { type: string; depth?: number; children?: MarkdownNode[] };

/**
 * A remark step that puts a result's headings under the page's h1: its top heading is an h2 whatever its Markdown
 * level, and deeper ones keep their distance to it, down to h6. It reads the parsed document, so an underlined
 * title counts and nothing in a code block does.
 */
export function remarkResultHeadings() {
  return (tree: MarkdownNode) => {
    const headings: MarkdownNode[] = [];
    const walk = (node: MarkdownNode) => {
      if (node.type === "heading") headings.push(node);
      node.children?.forEach(walk);
    };
    walk(tree);
    const top = Math.min(...headings.map((heading) => heading.depth ?? 1));
    for (const heading of headings) heading.depth = Math.min(6, Math.max(2, (heading.depth ?? 1) - top + 2));
  };
}

export const RESULT_PROSE =
  "prose max-w-none [&>:first-child]:mt-0 prose-headings:tracking-tight prose-h2:text-[22px] prose-h3:text-[20px] prose-h4:text-[17px] prose-p:text-[16px] prose-p:leading-relaxed prose-li:text-[16px] prose-a:underline-offset-4 prose-code:before:hidden prose-code:after:hidden";

// The first part of a long text: whole blocks up to the first blank line past this many characters.
const LEAD_CHARS = 700;
/** Less than this left after the first part is shown with it: a disclosure for a few lines is not worth a press. */
const REST_CHARS = 400;

/**
 * A long text's first part: its blocks up to a blank line past LEAD_CHARS,
 * outside a fenced block, so it renders as the start of the whole. Null when
 * the text is short enough to show as it is.
 */
function firstPart(text: string): string | null {
  let fence = "";
  let offset = 0;
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) fence = fence ? "" : marker;
    else if (!fence && !line.trim() && offset >= LEAD_CHARS) {
      return text.length - offset >= REST_CHARS ? text.slice(0, offset).trimEnd() : null;
    }
    offset += line.length + 1;
  }
  return null;
}

/**
 * What the file says, under it: the text Eneo laid out in it, named as a
 * preview since the file stays the document. Its headings sit under the page's
 * h1 as a text result's do. A long text shows its first part until Visa hela
 * texten, a disclosure of the text above it.
 */
function FilePreview({ text }: { text: string }) {
  const first = useMemo(() => firstPart(text), [text]);
  const [whole, setWhole] = useState(false);
  const more = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  const toggle = () => {
    setWhole(!whole);
    // Folding a long text back would leave the reader far below it: the button comes back into view with them.
    if (whole) requestAnimationFrame(() => more.current?.scrollIntoView({ block: "nearest" }));
  };
  return (
    <section aria-labelledby={`${id}-name`} className="flex flex-col gap-4 border-t border-border px-5 py-6 md:px-10 md:py-8">
      <p id={`${id}-name`} className="text-[13px] font-medium text-ink-mute">
        Förhandsvisning av texten i filen
      </p>
      <article id={`${id}-text`} className={RESULT_PROSE}>
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkResultHeadings]}>{whole || !first ? text : first}</ReactMarkdown>
      </article>
      {first && (
        <Button ref={more} type="button" variant="outline" className="self-start" aria-expanded={whole} aria-controls={`${id}-text`} onClick={toggle}>
          <ChevronDown
            data-icon="inline-start"
            aria-hidden
            className={cn("transition-transform duration-150 motion-reduce:transition-none", whole && "rotate-180")}
          />
          {whole ? "Visa mindre" : "Visa hela texten"}
        </Button>
      )}
    </section>
  );
}

/** Files larger than this are not read ahead for Dela; they download instead. */
const SHARE_LIMIT_BYTES = 25 * 1024 * 1024;

type Share = { kind: "file"; file: File } | { kind: "text" };

/**
 * Dela through the device's own share sheet, where there is one: the file when
 * the device takes its type and its size is known and under the cap (read
 * ahead, since a share must start from the press itself, and the read stops
 * when the document leaves the page); otherwise the text. Never the file's
 * link: it opens only with the owner's session. Nothing when the browser has
 * no share, or when there is no file to send and no text.
 */
function useShare(file: ResultFileView | null, url: string | null, text: string | null): Share | null {
  const [share, setShare] = useState<Share | null>(null);
  useEffect(() => {
    if (typeof navigator === "undefined" || typeof navigator.share !== "function") return;
    const controller = new AbortController();
    const instead: Share | null = text ? { kind: "text" } : null;
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
    await navigator.share(share.kind === "file" ? { files: [share.file], title } : { title, text: text ?? "" });
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
  preview = null,
  madeText = false,
}: {
  flowId: string;
  runId: string;
  /** The result's text, as markdown. */
  text: string | null;
  /** The file the flow made, the first one that can be fetched. */
  file: ResultFileView | null;
  /** What a share is called: the flow's name. */
  title: string;
  /** Where there is no text: what the file says, see fileText. */
  preview?: string | null;
  /** The flow makes text, not a document (`runMakesText`). */
  madeText?: boolean;
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

    <section aria-label={madeText ? "Texten" : "Dokumentet"} className="flex flex-col rounded-xl border bg-card">
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
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkResultHeadings]}>{text}</ReactMarkdown>
        </article>
      )}

      {/* The file, under Eneo's name: its type and size, and the name opens it where the browser can show it. No
          second download. */}
      {file && Icon && (
        <div data-file-row className={cn("relative flex items-center gap-3 px-5 py-3", text && "border-t border-border")}>
          <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
            <Icon className="size-[18px]" strokeWidth={2} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
            {file.previewable && download && inline ? (
              <OpenFile file={file} url={inline} download={download} name />
            ) : (
              <p className="text-[14px] font-medium leading-snug text-ink [overflow-wrap:anywhere]">{file.name}</p>
            )}
            <p className="text-[13px] text-ink-mute">{file.meta}</p>
          </div>
        </div>
      )}
      {preview && <FilePreview text={preview} />}
      <CopyStatus state={copyState} />
    </section>
    </>
  );
}
