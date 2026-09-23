"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, ChevronRight, Copy, Download, ExternalLink, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { runArtifactUrl } from "@/lib/api";
import type { ResultFileView } from "@/lib/run-files";
import { cn } from "@/lib/utils";
import { CopyStatus, useCopy } from "./CopyButton";
import { FILE_ICONS, OpenFile } from "./ResultFiles";

export const RESULT_PROSE =
  "prose max-w-none [&>:first-child]:mt-0 prose-headings:tracking-tight prose-h1:text-[22px] prose-h2:text-[20px] prose-h3:text-[17px] prose-p:text-[16px] prose-p:leading-relaxed prose-li:text-[16px] prose-a:underline-offset-4 prose-code:before:hidden prose-code:after:hidden";

/** Files larger than this are not read ahead for Dela; they download instead. */
const SHARE_LIMIT_BYTES = 25 * 1024 * 1024;

type Share = { kind: "file"; file: File } | { kind: "text" };

/**
 * Dela through the device's own share sheet, where there is one: the file when
 * the device can share that type (read ahead, since a share must start from the
 * press itself), otherwise the text. Nothing when the browser has no share.
 */
function useShare(file: ResultFileView | null, url: string | null, text: string | null): Share | null {
  const [share, setShare] = useState<Share | null>(null);
  useEffect(() => {
    if (typeof navigator === "undefined" || typeof navigator.share !== "function") return;
    let cancelled = false;
    const probe = file ? new File([""], file.name, { type: file.mimeType }) : null;
    const fileShareable =
      file && url && probe && (file.sizeBytes === null || file.sizeBytes <= SHARE_LIMIT_BYTES) &&
      typeof navigator.canShare === "function" && navigator.canShare({ files: [probe] });
    if (fileShareable) {
      fetch(url)
        .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(String(response.status)))))
        .then((blob) => {
          if (!cancelled) setShare({ kind: "file", file: new File([blob], file.name, { type: blob.type || file.mimeType }) });
        })
        .catch(() => {
          if (!cancelled && text) setShare({ kind: "text" });
        });
    } else if (text) {
      setShare({ kind: "text" });
    }
    return () => {
      cancelled = true;
    };
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
 * when there is no file). On a phone the text folds after its first part and
 * the actions are rows below it.
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
  const copyButton = text && (
    <Button type="button" variant={file ? "ghost" : "default"} onClick={copy}>
      <Copy data-icon="inline-start" aria-hidden />
      {copyState === "copied" ? "Kopierat" : copyState === "failed" ? "Kunde inte kopiera" : "Kopiera"}
      <span className="sr-only"> texten</span>
    </Button>
  );
  const shareButton = share && (
    <Button type="button" variant="ghost" onClick={() => void runShare(share, title, text)}>
      <Share2 data-icon="inline-start" aria-hidden />
      Dela
    </Button>
  );

  return (
    <section aria-label="Dokumentet" className="flex flex-col rounded-xl border bg-card">
      {/* From a tablet's width the document's actions sit on its top edge, beside the file they act on. */}
      <div
        className={cn(
          "hidden flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 sm:flex",
          text && "border-b border-border",
          file ? "justify-between" : "justify-end",
        )}
      >
        {file && Icon && (
          <div className="flex min-w-0 items-center gap-3">
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
              <Icon className="size-[18px]" strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <p className="text-[14px] font-medium leading-snug text-ink [overflow-wrap:anywhere]">{file.name}</p>
              <p className="text-[13px] text-ink-mute">{file.meta}</p>
            </div>
          </div>
        )}
        <div className="-mr-1 ml-auto flex flex-wrap items-center gap-1">
          {copyButton}
          {shareButton}
          {file?.previewable && download && inline && (
            <OpenFile file={file} url={inline} download={download} variant="ghost" />
          )}
          {primaryDownload}
        </div>
      </div>

      {text && <DocumentText text={text} />}

      {/* A phone lists the actions as rows, each a whole-width target. */}
      <ItemGroup className={cn("p-1 sm:hidden", text && "border-t border-border")}>
        {file && Icon && (
          <div className="flex items-center gap-3 px-3 py-3">
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
              <Icon className="size-[18px]" strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <p className="text-[15px] font-medium leading-snug text-ink [overflow-wrap:anywhere]">{file.name}</p>
              <p className="text-[13px] text-ink-mute">{file.meta}</p>
            </div>
          </div>
        )}
        {file?.previewable && inline && (
          <ActionRow icon={<ExternalLink aria-hidden />} href={inline} newTab>
            Öppna {file.typeLabel}
            <span className="sr-only"> i en ny flik</span>
          </ActionRow>
        )}
        {file && download && (
          <ActionRow icon={<Download aria-hidden />} href={download} download>
            Ladda ner {file.typeLabel}
          </ActionRow>
        )}
        {text && (
          <ActionRow icon={<Copy aria-hidden />} onClick={copy}>
            {copyState === "copied" ? "Kopierat" : copyState === "failed" ? "Kunde inte kopiera" : "Kopiera texten"}
          </ActionRow>
        )}
        {share && (
          <ActionRow icon={<Share2 aria-hidden />} onClick={() => void runShare(share, title, text)}>
            Dela
          </ActionRow>
        )}
      </ItemGroup>
      <CopyStatus state={copyState} />
    </section>
  );
}

/** The text as a page; on a phone a long one folds after its start, with "Visa hela dokumentet". */
function DocumentText({ text }: { text: string }) {
  const article = useRef<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [folds, setFolds] = useState(false);
  const id = "result-document-text";

  useLayoutEffect(() => {
    const el = article.current;
    if (!el || expanded) return;
    const measure = () => setFolds(el.scrollHeight > el.clientHeight + 8);
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [text, expanded]);

  return (
    <>
      <article
        ref={article}
        id={id}
        className={cn(
          RESULT_PROSE,
          "px-5 py-6 md:px-10 md:py-9",
          !expanded && "max-sm:max-h-[26rem] max-sm:overflow-hidden",
          !expanded && folds && "max-sm:[mask-image:linear-gradient(to_bottom,black_65%,transparent)]",
        )}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </article>
      {folds && !expanded && (
        <Button
          type="button"
          variant="link"
          className="-mt-2 mb-2 self-start px-5 sm:hidden"
          aria-expanded={false}
          aria-controls={id}
          onClick={() => setExpanded(true)}
        >
          Visa hela dokumentet
          <ChevronDown data-icon="inline-end" aria-hidden />
        </Button>
      )}
    </>
  );
}

function ActionRow({
  icon,
  href,
  download,
  newTab,
  onClick,
  children,
}: {
  icon: ReactNode;
  href?: string;
  download?: boolean;
  newTab?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  const body = (
    <>
      <ItemMedia className="text-ink-soft [&_svg]:size-5">{icon}</ItemMedia>
      <ItemContent>
        <ItemTitle className="text-[16px] font-normal">{children}</ItemTitle>
      </ItemContent>
      <ItemActions>
        <ChevronRight aria-hidden className="size-4 text-ink-mute" />
      </ItemActions>
    </>
  );
  return (
    <Item asChild size="sm" className="min-h-11 flex-nowrap rounded-lg px-3 py-2 text-left hover:bg-accent">
      {href ? (
        <a href={href} download={download || undefined} target={newTab ? "_blank" : undefined} rel={newTab ? "noopener noreferrer" : undefined}>
          {body}
        </a>
      ) : (
        <button type="button" onClick={onClick} className="w-full">
          {body}
        </button>
      )}
    </Item>
  );
}

