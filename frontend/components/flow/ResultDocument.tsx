import { useEffect, useId, useMemo, useRef, useState } from "react";
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
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { runArtifactUrl } from "@/lib/api";
import { downloadBlob } from "@/lib/download";
import type { ResultFileView } from "@/lib/run-files";
import { copyableHtml, useCopy } from "./CopyButton";
import { Markdown } from "./Markdown";
import { ProblemAlert } from "./ProblemAlert";
import { DownloadLink, FILE_ICONS, FileName, LAPTOP, OpenFile } from "./ResultFiles";
import { pressing, savingWay, useFileAccess, waiting } from "./useFileAccess";
import { useRoomInRow } from "./useRoomInRow";
import fileStyles from "./ResultFiles.module.css";

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
      <article id={`${id}-text`}>
        <Markdown>{whole || !first ? text : first}</Markdown>
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

/** What Dela sends, or that the file is still being read for it. */
type Share = { kind: "file"; file: File } | { kind: "text" } | { kind: "reading" };

/** What Dela would send, known at once: the file when the device takes its type and its size is known and under the cap, else the text. */
function shareKind(name: string | null, mimeType: string, sizeBytes: number | null, url: string | null, text: string | null): "file" | "text" | null {
  if (typeof navigator.share !== "function") return null;
  const probe = name !== null ? new File([""], name, { type: mimeType }) : null;
  const fileShareable =
    probe !== null && url && sizeBytes !== null && sizeBytes <= SHARE_LIMIT_BYTES &&
    typeof navigator.canShare === "function" && navigator.canShare({ files: [probe] });
  return fileShareable ? "file" : text ? "text" : null;
}

/**
 * Dela through the device's own share sheet, where there is one: the file when
 * the device takes its type and its size is known and under the cap (read
 * ahead, since a share must start from the press itself, and the read stops
 * when the document leaves the page); otherwise the text. Never the file's
 * link: it opens only with the owner's session. Nothing when the browser has
 * no share, or when there is no file to send and no text.
 *
 * Whether there is a Dela is known at once, so it has its place from the first
 * draw and waits there while the file is read: an action that arrived with the
 * file would move the document under a finger, seconds in on a slow line.
 */
function useShare(file: ResultFileView | null, url: string | null, text: string | null): Share | null {
  // The file's own facts, not the object: the page builds its file views anew at every draw, and the read must not start over for them.
  const name = file?.name ?? null;
  const mimeType = file?.mimeType ?? "";
  const sizeBytes = file?.sizeBytes ?? null;
  const kind = useMemo(() => shareKind(name, mimeType, sizeBytes, url, text), [name, mimeType, sizeBytes, url, text]);
  // The file once it is read; `file: null` when the read failed.
  const [read, setRead] = useState<{ file: File | null } | null>(null);
  useEffect(() => {
    if (kind !== "file" || name === null || !url) return;
    const controller = new AbortController();
    setRead(null);
    fetch(url, { signal: controller.signal })
      .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(String(response.status)))))
      .then((blob) => {
        if (!controller.signal.aborted) setRead({ file: new File([blob], name, { type: blob.type || mimeType }) });
      })
      .catch(() => {
        if (!controller.signal.aborted) setRead({ file: null });
      });
    return () => controller.abort();
  }, [kind, name, mimeType, url]);
  if (kind === null) return null;
  if (kind === "text") return { kind: "text" };
  if (read === null) return { kind: "reading" };
  return read.file ? { kind: "file", file: read.file } : text ? { kind: "text" } : null;
}

async function runShare(share: Share, title: string, text: string | null): Promise<void> {
  if (share.kind === "reading") return;
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
  textIsPreview = false,
  label = "Dokumentet",
  downloadName,
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
  /** The text is only the beginning of the file-backed result. */
  textIsPreview?: boolean;
  /** What the run makes, named ("Dokumentet", "Texten"; `outputWords`). */
  label?: string;
  /** What a text without a file of its own downloads as (`runFileName`). */
  downloadName?: string;
}) {
  const download = file ? runArtifactUrl(flowId, runId, file.fileId) : null;
  const inline = file ? runArtifactUrl(flowId, runId, file.fileId, true) : null;
  const share = useShare(file, download, text);
  const access = useFileAccess(flowId, runId);
  // The text as it is drawn, for a copy that keeps its headings, lists and bold.
  const article = useRef<HTMLElement | null>(null);
  const [copyState, copy] = useCopy(text ?? "", () => article.current && copyableHtml(article.current));
  const Kind = file ? FILE_ICONS[file.kind] : null;
  // The wide bar sits on the document's top edge; narrower, the actions come above it. One of them at a time.
  const wide = useMediaQuery(LAPTOP, true);
  const room = useRoomInRow();

  const downloadLabel = file ? `Ladda ner ${file.typeLabel === "Text" ? "textfilen" : file.typeLabel}` : null;
  const primaryDownload = file && download && (
    <Button
      as={DownloadLink}
      href={download}
      variant="primary"
      icon={<Icon icon={Download} />}
      label={`${downloadLabel}, ${file.name}`}
      onClick={pressing(access, file.fileId, savingWay(file))}
      {...waiting(access, file.fileId, savingWay(file))}
    >
      {downloadLabel}
    </Button>
  );
  // A copy is confirmed where it was asked for: the button's check in place of its icon, or the menu's own button when
  // it came from there, and "Kopierat" to a screen reader. The words stay, so nothing in the row moves or folds; only a
  // copy that fails says so in words.
  const copyLabel = copyState === "failed" ? "Kunde inte kopiera" : null;
  const copyIcon = <Icon icon={copyState === "copied" ? "check" : "copy"} />;
  const copyName = textIsPreview ? "Kopiera början" : "Kopiera texten";
  const shareName = textIsPreview && share?.kind === "text" ? "Dela början" : "Dela";
  // Copying the text is one of the more actions when the file is the filled one above it.
  const copyMore = Boolean(text && file);
  // A text with no file of its own is saved as one, as it is written.
  const saveText = text && !file && downloadName ? () => downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), downloadName) : null;
  const saveButton = (variant: "ghost" | "secondary") =>
    saveText && (
      <Button variant={variant} icon={<Icon icon={Download} />} label={`Ladda ner ${downloadName}`} onClick={saveText}>
        Ladda ner
      </Button>
    );
  // The one more action beside Dela: copying where the file is the filled action, else saving the text.
  const moreItem = copyMore ? (
    <DropdownMenuItem icon="copy" label={copyName} onClick={() => void copy()} />
  ) : (
    saveText && <DropdownMenuItem icon={Download} label="Ladda ner" onClick={saveText} />
  );
  const moreButton = copyMore ? <Button icon={copyIcon} label={copyLabel ?? copyName} onClick={copy} /> : saveButton("secondary");
  // Dela wherever the device has a share sheet, at every width.
  const shareButton = (variant: "ghost" | "secondary") =>
    share && (
      <Button variant={variant} icon={<Icon icon={Share2} />} label={shareName} isDisabled={share.kind === "reading"} onClick={() => void runShare(share, title, text)} />
    );

  return (
    <>
      {/* Narrower: above the document, the download first, then the more actions. The file opens from its name, on its
          row in the document. */}
      {!wide && (
        <HStack ref={room.ref} wrap="wrap" vAlign="center" gap={2}>
          {primaryDownload}
          {text && !file && (
            <Button variant="primary" icon={copyIcon} label={copyLabel ?? copyName} onClick={copy} />
          )}
          {/* Two more actions stand beside it where the row has room for them, and fold into a menu where it has not.
              One is a button of its own, never a menu of one. */}
          {moreItem && share && !room.fits ? (
            <DropdownMenu
              button={{ label: "Fler alternativ", isIconOnly: true, variant: "ghost", icon: <Icon icon={copyState === "copied" ? "check" : "moreHorizontal"} /> }}
              hasChevron={false}
              alignment="center"
            >
              {moreItem}
              <DropdownMenuItem icon={Share2} label={shareName} isDisabled={share.kind === "reading"} onClick={() => void runShare(share, title, text)} />
            </DropdownMenu>
          ) : (
            <>
              {moreButton}
              {shareButton("secondary")}
            </>
          )}
        </HStack>
      )}

      {access.problem && <ProblemAlert problem={{ title: access.problem.message, retry: true }} onRetry={access.again} />}

      <Card padding={0} role="region" aria-label={label}>
        {/* From a laptop's width: Dela, Kopiera and the one download on the document's top edge, above its text. A file
            without text of its own has Dela and the download on its row, as the files under it have theirs. */}
        {wide && text && (
          <>
            <HStack hAlign="end" vAlign="center" gap={1} padding={2}>
              {shareButton("ghost")}
              {saveButton("ghost")}
              {text && (
                <Button
                  variant={file ? "ghost" : "primary"}
                  icon={copyIcon}
                  label={copyLabel ?? copyName}
                  onClick={copy}
                >
                  {copyLabel ?? (file && !textIsPreview ? "Kopiera" : copyName)}
                </Button>
              )}
              {primaryDownload}
            </HStack>
            <Divider />
          </>
        )}

        {text && (
          <VStack as="article" ref={article} padding={6}>
            <Markdown>{text}</Markdown>
          </VStack>
        )}

        {/* The file, under Eneo's name: its type and size, and the name opens it where the browser can show it. No
            second download. */}
        {file && Kind && (
          <>
            {text && <Divider />}
            {/* The name has the row; its actions stand beside it where the line has room for both, and drop under it
                where it has not (a laptop's narrower column), as Fler filer's rows do: never a name of three lines
                squeezed between them. */}
            <HStack data-file-row wrap="wrap" vAlign="center" gap={2}>
              <Item
                className={fileStyles.documentFile}
                startContent={<Icon icon={Kind} />}
                label={file.previewable && download && inline ? <OpenFile file={file} url={inline} download={download} name access={access} /> : <Text><FileName name={file.name} /></Text>}
                description={file.meta}
              />
              {wide && !text && (
                <HStack vAlign="center" gap={1} paddingInline={2} paddingBlockEnd={2}>
                  {shareButton("ghost")}
                  {primaryDownload}
                </HStack>
              )}
            </HStack>
          </>
        )}
        {preview && (
          <>
            <Divider />
            <FilePreview text={preview} />
          </>
        )}
      </Card>
    </>
  );
}
