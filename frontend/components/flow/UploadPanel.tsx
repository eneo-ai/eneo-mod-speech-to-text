"use client";

import { FileAudio, FileText, Upload } from "lucide-react";
import { useId, useState, type DragEvent, type Ref } from "react";
import { Button } from "@/components/ui/button";
import type { RunContractStepInput } from "@/lib/api";
import { acceptedFormats, fileAccept, type ChosenFile } from "@/lib/flow-session";
import { formatBytes, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Ladda upp: the file chooser, what the flow takes, a zone to click or drop a
 * file on, and the chosen file with its size and length. The page's primary
 * action opens the same chooser through `inputRef`; "Byt fil" picks again.
 */
export function UploadPanel({
  step,
  file,
  audio,
  inputRef,
  onChoose,
}: {
  step: RunContractStepInput | null;
  file: ChosenFile | null;
  audio: boolean;
  inputRef: Ref<HTMLInputElement>;
  onChoose: (file: File) => void;
}) {
  const inputId = useId();
  const [dragging, setDragging] = useState(false);
  const formats = acceptedFormats(step?.accepted_mimetypes);
  const limit = step?.max_file_size_bytes ? `högst ${formatBytes(step.max_file_size_bytes)}` : null;
  const takes = [formats, limit].filter(Boolean).join(", ");

  const dropTarget = {
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const dropped = event.dataTransfer.files[0];
      if (dropped) onChoose(dropped);
    },
  };

  // One keyboard stop: the primary action. The zone is a label for the chooser, a larger place to click.
  const chooser = (
    <input
      ref={inputRef}
      id={inputId}
      type="file"
      accept={fileAccept(step?.accepted_mimetypes) ?? (audio ? "audio/*" : undefined)}
      className="sr-only"
      tabIndex={-1}
      aria-hidden
      onChange={(event) => {
        const chosen = event.target.files?.[0];
        if (chosen) onChoose(chosen);
        event.target.value = "";
      }}
    />
  );
  const FileIcon = audio ? FileAudio : FileText;

  if (file) {
    return (
      <>
        {chooser}
        <div
          {...dropTarget}
          className={cn(
            "flex items-center gap-3 rounded-xl border bg-paper p-4 transition-colors duration-150",
            dragging ? "border-primary bg-primary-soft/40" : "border-rule-soft",
          )}
        >
          <FileIcon aria-hidden className="size-6 shrink-0 text-primary" strokeWidth={1.75} />
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-medium text-ink [overflow-wrap:anywhere]">{file.filename}</p>
            <p className="text-[13px] text-ink-soft">
              {formatBytes(file.blob.size)}
              {file.durationMs != null && ` · ${formatDuration(file.durationMs)}`}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="h-11 shrink-0"
            onClick={() => document.getElementById(inputId)?.click()}
          >
            Byt fil
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      {chooser}
      <label
        htmlFor={inputId}
        data-drop-zone
        {...dropTarget}
        className={cn(
          "flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed px-5 py-6 text-center transition-colors duration-150",
          dragging ? "border-primary bg-primary-soft/40" : "border-rule bg-paper hover:border-primary hover:bg-primary-soft/20",
        )}
      >
        <Upload aria-hidden className="size-6 text-primary" strokeWidth={1.75} />
        <span className="hidden text-[15px] font-medium text-ink md:[@media(pointer:fine)]:block">
          {audio ? "Dra en ljudfil hit eller klicka för att välja en." : "Dra en fil hit eller klicka för att välja en."}
        </span>
        {takes && <span className="block text-[14px] text-ink-soft">Flödet tar emot {takes}.</span>}
      </label>
    </>
  );
}
