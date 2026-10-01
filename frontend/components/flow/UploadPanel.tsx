"use client";

import { FileAudio, FileText, Upload } from "lucide-react";
import { useId, useState, type DragEvent, type Ref } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import type { RunContractStepInput } from "@/lib/api";
import { acceptedFormats, fileAccept, type ChosenFile } from "@/lib/flow-session";
import { formatBytes, formatDuration } from "@/lib/format";
import styles from "./UploadPanel.module.css";

/**
 * Ladda upp: the file chooser, what the flow takes, a zone to click or drop a
 * file on, and the chosen file with its size and length. The page's primary
 * action opens the same chooser through `inputRef`; "Byt fil" picks again.
 */
export function UploadPanel({
  step,
  file,
  audio,
  optional = false,
  inputRef,
  onChoose,
}: {
  step: RunContractStepInput | null;
  file: ChosenFile | null;
  audio: boolean;
  /** The flow runs without a file: the primary action sends, so choosing gets its own keyboard stop. */
  optional?: boolean;
  inputRef: Ref<HTMLInputElement>;
  onChoose: (file: File) => void;
}) {
  const inputId = useId();
  const [dragging, setDragging] = useState(false);
  const formats = acceptedFormats(step?.accepted_mimetypes);
  const maxima = [
    step?.max_file_size_bytes ? formatBytes(step.max_file_size_bytes) : null,
    step?.max_duration_seconds ? formatDuration(step.max_duration_seconds * 1000).replace(/ /g, "\u00a0") : null,
  ].filter(Boolean);
  const limit = maxima.length > 0 ? `högst ${maxima.join(" och ")}` : null;
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

  // One keyboard stop: the primary action. The zone is a larger place to click, not a control of its own.
  // A real file input stays (hidden): the page's primary action opens its chooser, and a test sets its files.
  const chooser = (
    <input
      ref={inputRef}
      id={inputId}
      type="file"
      accept={fileAccept(step?.accepted_mimetypes) ?? (audio ? "audio/*" : undefined)}
      hidden
      tabIndex={-1}
      aria-hidden
      onChange={(event) => {
        const chosen = event.target.files?.[0];
        if (chosen) onChoose(chosen);
        event.target.value = "";
      }}
    />
  );
  const choose = () => document.getElementById(inputId)?.click();
  const FileIcon = audio ? FileAudio : FileText;
  // In the same place whichever view shows, so the choice is said once.
  const chosenStatus = (
    <VisuallyHidden as="p" role="status">
      {file ? `Vald fil: ${file.filename}` : ""}
    </VisuallyHidden>
  );

  if (file) {
    return (
      <>
        {chooser}
        {chosenStatus}
        <Card padding={4} variant={dragging ? "blue" : "default"} {...dropTarget}>
          <HStack gap={3} hAlign="between" align="center">
            <HStack gap={3} align="center">
              <Icon icon={FileIcon} color="accent" />
              <VStack gap={0.5}>
                <Text weight="medium">{file.filename}</Text>
                <Text type="supporting">
                  {formatBytes(file.blob.size)}
                  {file.durationMs != null && ` · ${formatDuration(file.durationMs)}`}
                </Text>
              </VStack>
            </HStack>
            <Button label="Byt fil" variant="secondary" onClick={choose} />
          </HStack>
        </Card>
      </>
    );
  }

  return (
    <>
      {chooser}
      {chosenStatus}
      <Card padding={5} variant={dragging ? "blue" : "default"} data-drop-zone className={styles.zone} onClick={choose} {...dropTarget}>
        <VStack hAlign="center" gap={2}>
          <Icon icon={Upload} color="accent" />
          <Text weight="medium" justify="center" className={styles.fineOnly}>
            {audio ? "Dra en ljudfil hit eller klicka för att välja en." : "Dra en fil hit eller klicka för att välja en."}
          </Text>
          {takes && (
            <Text type="supporting" justify="center">
              Flödet tar emot {takes}.
            </Text>
          )}
        </VStack>
      </Card>
      {optional && (
        <HStack hAlign="between" align="center" gap={3} wrap="wrap">
          <Text color="secondary">{audio ? "Ljudfilen" : "Filen"} är valfri.</Text>
          <Button label={audio ? "Välj ljudfil" : "Välj fil"} variant="secondary" onClick={choose} />
        </HStack>
      )}
    </>
  );
}
