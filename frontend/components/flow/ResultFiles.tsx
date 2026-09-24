"use client";

import { useRef } from "react";
import {
  Download,
  ExternalLink,
  Eye,
  File,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { runArtifactUrl } from "@/lib/api";
import type { FileKind, ResultFileView } from "@/lib/run-files";

export const FILE_ICONS: Record<FileKind, LucideIcon> = {
  pdf: FileText,
  word: FileType,
  spreadsheet: FileSpreadsheet,
  text: FileText,
  audio: FileAudio,
  image: FileImage,
  other: File,
};

/** The run's files under Eneo's names, each opened or downloaded through the module. */
export function ResultFiles({
  flowId,
  runId,
  files,
  title = "Filer",
}: {
  flowId: string;
  runId: string;
  files: readonly ResultFileView[];
  title?: string;
}) {
  return (
    <section aria-labelledby="result-files" className="flex flex-col gap-3">
      <h2 id="result-files" className="text-[17px] font-semibold tracking-tight">
        {title}
      </h2>
      <ItemGroup className="gap-2">
        {files.map((file) => {
          const Icon = FILE_ICONS[file.kind];
          const download = runArtifactUrl(flowId, runId, file.fileId);
          return (
            <Item key={file.fileId} role="listitem" variant="outline" className="bg-card">
              <ItemMedia variant="icon">
                <Icon aria-hidden />
              </ItemMedia>
              <ItemContent className="min-w-48">
                <ItemTitle className="w-auto text-[15px] [overflow-wrap:anywhere]">{file.name}</ItemTitle>
                <ItemDescription>{file.meta}</ItemDescription>
              </ItemContent>
              {file.available && (
                <ItemActions className="flex-wrap">
                  {file.previewable && (
                    <OpenFile file={file} url={runArtifactUrl(flowId, runId, file.fileId, true)} download={download} />
                  )}
                  <Button asChild variant="outline">
                    <a href={download} download>
                      <Download data-icon="inline-start" aria-hidden />
                      Ladda ner<span className="sr-only"> {file.name}</span>
                    </a>
                  </Button>
                </ItemActions>
              )}
            </Item>
          );
        })}
      </ItemGroup>
    </section>
  );
}

/**
 * A PDF opens in the browser's own viewer: in a titled dialog where there is
 * room for it, in a new tab on a phone. The dialog opens on its title with its
 * actions and Stäng before the viewer. The viewer is not in the Tab order: the
 * browser's PDF frame keeps Escape to itself and shows this page no focus state,
 * so keyboard users read the file with "Öppna i ny flik", in a whole tab.
 */
export function OpenFile({
  file,
  url,
  download,
  variant = "outline",
  size,
}: {
  file: ResultFileView;
  url: string;
  download: string;
  variant?: "outline" | "ghost";
  size?: "sm";
}) {
  const title = useRef<HTMLHeadingElement | null>(null);
  return (
    <>
      <Button asChild variant={variant} size={size} className="sm:hidden">
        <a href={url} target="_blank" rel="noopener noreferrer">
          <ExternalLink data-icon="inline-start" aria-hidden />
          Öppna<span className="sr-only"> {file.name} i en ny flik</span>
        </a>
      </Button>
      <Dialog>
        <DialogTrigger asChild>
          <Button variant={variant} size={size} className="hidden sm:inline-flex">
            <Eye data-icon="inline-start" aria-hidden />
            Öppna<span className="sr-only"> {file.name}</span>
          </Button>
        </DialogTrigger>
        <DialogContent
          hideClose
          className="flex h-[85vh] max-w-5xl flex-col"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            title.current?.focus();
          }}
        >
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
            <div className="flex min-w-0 flex-col gap-1.5">
              <DialogTitle
                ref={title}
                tabIndex={-1}
                className="rounded-sm leading-snug [overflow-wrap:anywhere] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {file.name}
              </DialogTitle>
              <DialogDescription>{file.meta}</DialogDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <a href={url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink data-icon="inline-start" aria-hidden />
                  Öppna i ny flik
                </a>
              </Button>
              <Button asChild variant="outline">
                <a href={download} download>
                  <Download data-icon="inline-start" aria-hidden />
                  Ladda ner
                </a>
              </Button>
              <DialogClose asChild>
                <Button type="button" variant="ghost">
                  Stäng
                </Button>
              </DialogClose>
            </div>
          </div>
          <iframe src={url} title={file.name} tabIndex={-1} className="min-h-0 w-full flex-1 rounded-md border bg-card" />
        </DialogContent>
      </Dialog>
    </>
  );
}
