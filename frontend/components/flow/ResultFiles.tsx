"use client";

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
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
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

const ICONS: Record<FileKind, LucideIcon> = {
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
}: {
  flowId: string;
  runId: string;
  files: readonly ResultFileView[];
}) {
  return (
    <section aria-labelledby="result-files" className="flex flex-col gap-3">
      <h2 id="result-files" className="text-lg font-semibold tracking-tight">
        Filer
      </h2>
      <ItemGroup className="gap-2">
        {files.map((file) => {
          const Icon = ICONS[file.kind];
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
 * room for it, in a new tab on a phone.
 */
function OpenFile({ file, url, download }: { file: ResultFileView; url: string; download: string }) {
  return (
    <>
      <Button asChild variant="outline" className="sm:hidden">
        <a href={url} target="_blank" rel="noopener noreferrer">
          <ExternalLink data-icon="inline-start" aria-hidden />
          Öppna<span className="sr-only"> {file.name} i en ny flik</span>
        </a>
      </Button>
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="outline" className="hidden sm:inline-flex">
            <Eye data-icon="inline-start" aria-hidden />
            Öppna<span className="sr-only"> {file.name}</span>
          </Button>
        </DialogTrigger>
        <DialogContent className="flex h-[85vh] max-w-5xl flex-col">
          <DialogHeader className="pr-10">
            <DialogTitle className="leading-snug [overflow-wrap:anywhere]">{file.name}</DialogTitle>
            <DialogDescription>{file.meta}</DialogDescription>
          </DialogHeader>
          <iframe src={url} title={file.name} className="min-h-0 w-full flex-1 rounded-md border bg-card" />
          <DialogFooter>
            <Button asChild variant="outline">
              <a href={url} target="_blank" rel="noopener noreferrer">
                <ExternalLink data-icon="inline-start" aria-hidden />
                Öppna i ny flik
              </a>
            </Button>
            <Button asChild>
              <a href={download} download>
                <Download data-icon="inline-start" aria-hidden />
                Ladda ner
              </a>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
