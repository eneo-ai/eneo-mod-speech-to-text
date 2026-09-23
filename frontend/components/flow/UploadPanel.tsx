"use client";

import { FileAudio, Upload } from "lucide-react";
import { useState, type DragEvent } from "react";
import { Button } from "@/components/ui/button";
import type { RunContractStepInput } from "@/lib/api";
import { acceptedFormats, type ChosenFile } from "@/lib/flow-session";
import { formatBytes, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Ladda upp: what the flow takes, a place to drop a file on a tablet or
 * laptop, and the chosen file with its size and length. "Välj ljudfil"
 * (the primary action) opens the picker; "Byt fil" picks again.
 */
export function UploadPanel({
  step,
  file,
  audio,
  onPick,
  onDrop,
}: {
  step: RunContractStepInput | null;
  file: ChosenFile | null;
  audio: boolean;
  onPick: () => void;
  onDrop: (file: File) => void;
}) {
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
      if (dropped) onDrop(dropped);
    },
  };

  if (file) {
    return (
      <div
        {...dropTarget}
        className={cn(
          "flex items-center gap-3 rounded-xl border bg-paper p-4 transition-colors duration-150",
          dragging ? "border-primary bg-primary-soft/40" : "border-rule-soft",
        )}
      >
        <FileAudio aria-hidden className="size-6 shrink-0 text-primary" strokeWidth={1.75} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium text-ink">{file.filename}</p>
          <p className="text-[13px] text-ink-soft">
            {formatBytes(file.blob.size)}
            {file.durationMs != null && ` · ${formatDuration(file.durationMs)}`}
          </p>
        </div>
        <Button type="button" variant="outline" className="h-11 shrink-0" onClick={onPick}>
          Byt fil
        </Button>
      </div>
    );
  }

  return (
    <div
      {...dropTarget}
      className={cn(
        "flex flex-col items-center gap-2 rounded-xl border border-dashed px-5 py-6 text-center transition-colors duration-150",
        dragging ? "border-primary bg-primary-soft/40" : "border-rule bg-paper",
      )}
    >
      <Upload aria-hidden className="size-6 text-primary" strokeWidth={1.75} />
      <p className="hidden text-[15px] font-medium text-ink md:[@media(pointer:fine)]:block">
        {audio ? "Dra en ljudfil hit, eller välj en." : "Dra en fil hit, eller välj en."}
      </p>
      {takes && <p className="text-[14px] text-ink-soft">Flödet tar emot {takes}.</p>}
    </div>
  );
}
