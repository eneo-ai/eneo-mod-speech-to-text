"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, ChevronUp, Download, Share2 } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Item } from "@astryxdesign/core/Item";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { runArtifactUrl } from "@/lib/api";
import type { ResultFileView } from "@/lib/run-files";
import { CopyStatus, useCopy } from "./CopyButton";
import styles from "./ResultDocument.module.css";
import { DownloadLink, FILE_ICONS, LAPTOP, OpenFile, useMediaMatch } from "./ResultFiles";

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

/**
 * What a result says, as a page: Markdown with its headings under the page's h1 and bare addresses as links. The
 * design system's Markdown does not read an underlined title as a heading, so the document keeps react-markdown and
 * takes the design system's text scale and tokens from a CSS Module.
 */
function ResultMarkdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm, remarkResultHeadings]}>{children}</ReactMarkdown>;
}

// The first part of a long text: whole blocks up to the first blank line past this many characters,
const LEAD_CHARS = 700;
// and when no blank line comes before this many, the last line end or word boundary before it.
const LEAD_MAX_CHARS = 1_400;
/** Less than this left after the first part is shown with it: a disclosure for a few lines is not worth a press. */
const REST_CHARS = 400;

/**
 * A long text's first part, outside a fenced block so it renders as the start of the whole: its blocks up to a
 * blank line between LEAD_CHARS and LEAD_MAX_CHARS, else up to the last line end or space before LEAD_MAX_CHARS,
 * with an ellipsis when that falls inside a line. Null when the text is short enough to show as it is.
 */
function firstPart(text: string): string | null {
  let fence = "";
  let offset = 0;
  let cut = 0;
  let inLine = false;
  for (const line of text.split("\n")) {
    if (offset > LEAD_MAX_CHARS) break;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    const toggles = Boolean(marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length)));
    if (toggles) fence = fence ? "" : marker!;
    if (!fence && !toggles && !line.trim() && offset >= LEAD_CHARS) {
      [cut, inLine] = [offset, false];
      break;
    }
    if (!fence) {
      // Outside a fence after this line: its end, or a paragraph's last space before the bound, is a cut.
      const room = LEAD_MAX_CHARS - offset;
      const end = line.length <= room ? line.length : toggles ? -1 : line.lastIndexOf(" ", room);
      if (end > 0) [cut, inLine] = [offset + end, end < line.length];
    }
    offset += line.length + 1;
  }
  if (!cut || text.length - cut < REST_CHARS) return null;
  return text.slice(0, cut).trimEnd() + (inLine ? " …" : "");
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
    <VStack as="section" aria-labelledby={`${id}-name`} gap={4} padding={6}>
      <Text as="p" id={`${id}-name`} type="supporting">
        Förhandsvisning av texten i filen
      </Text>
      <article id={`${id}-text`} className={styles.prose}>
        <ResultMarkdown>{whole || !first ? text : first}</ResultMarkdown>
      </article>
      {first && (
        <HStack>
          <Button
            ref={more}
            aria-expanded={whole}
            aria-controls={`${id}-text`}
            icon={<Icon icon={whole ? ChevronUp : ChevronDown} />}
            label={whole ? "Visa mindre" : "Visa hela texten"}
            onClick={toggle}
          />
        </HStack>
      )}
    </VStack>
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
  label = "Dokumentet",
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
  /** What the run makes, named ("Dokumentet", "Texten"; `outputWords`). */
  label?: string;
}) {
  const download = file ? runArtifactUrl(flowId, runId, file.fileId) : null;
  const inline = file ? runArtifactUrl(flowId, runId, file.fileId, true) : null;
  const share = useShare(file, download, text);
  const [copyState, copy] = useCopy(text ?? "");
  const Kind = file ? FILE_ICONS[file.kind] : null;
  // The wide bar sits on the document's top edge; narrower, the actions come above it. One of them at a time.
  const wide = useMediaMatch(LAPTOP);

  const primaryDownload = file && download && (
    <Button
      as={DownloadLink}
      href={download}
      variant="primary"
      icon={<Icon icon={Download} />}
      label={`Ladda ner ${file.typeLabel}, ${file.name}`}
    >
      {`Ladda ner ${file.typeLabel}`}
    </Button>
  );
  const copyLabel = copyState === "copied" ? "Kopierat" : copyState === "failed" ? "Kunde inte kopiera" : null;

  return (
    <>
      {/* Narrower: above the document, the download first, opening the file beside it, the rest under Fler alternativ. */}
      {!wide && (
        <HStack wrap="wrap" vAlign="center" gap={2}>
          {primaryDownload}
          {file?.previewable && inline && (
            <Button
              href={inline}
              target="_blank"
              rel="noopener noreferrer"
              icon={<Icon icon="externalLink" />}
              label={`Öppna ${file.typeLabel} i en ny flik`}
            >
              {`Öppna ${file.typeLabel}`}
            </Button>
          )}
          {text && !file && (
            <Button variant="primary" icon={<Icon icon="copy" />} label={copyLabel ?? "Kopiera texten"} onClick={copy} />
          )}
          {((text && file) || share) && (
            <DropdownMenu
              button={{ label: "Fler alternativ", isIconOnly: true, variant: "ghost", icon: <Icon icon="moreHorizontal" /> }}
              hasChevron={false}
              alignment="end"
            >
              {text && file && <DropdownMenuItem icon="copy" label="Kopiera texten" onClick={() => void copy()} />}
              {share && <DropdownMenuItem icon={Share2} label="Dela" onClick={() => void runShare(share, title, text)} />}
            </DropdownMenu>
          )}
        </HStack>
      )}

      <Card padding={0} role="region" aria-label={label}>
        {/* From a laptop's width: Kopiera and the one download on the document's top edge. */}
        {wide && (
          <>
            <HStack hAlign="end" vAlign="center" gap={1} padding={2}>
              {text && (
                <Button
                  variant={file ? "ghost" : "primary"}
                  icon={<Icon icon="copy" />}
                  label={copyLabel ?? "Kopiera texten"}
                  onClick={copy}
                >
                  {copyLabel ?? (file ? "Kopiera" : "Kopiera texten")}
                </Button>
              )}
              {primaryDownload}
            </HStack>
            <Divider />
          </>
        )}

        {text && (
          <VStack as="article" padding={6} className={styles.prose}>
            <ResultMarkdown>{text}</ResultMarkdown>
          </VStack>
        )}

        {/* The file, under Eneo's name: its type and size, and the name opens it where the browser can show it. No
            second download. */}
        {file && Kind && (
          <>
            {text && <Divider />}
            <Item
              data-file-row
              startContent={<Icon icon={Kind} />}
              label={file.previewable && download && inline ? <OpenFile file={file} url={inline} download={download} name /> : <Text>{file.name}</Text>}
              description={file.meta}
            />
          </>
        )}
        {preview && (
          <>
            <Divider />
            <FilePreview text={preview} />
          </>
        )}
        <CopyStatus state={copyState} />
      </Card>
    </>
  );
}
