"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ComponentProps } from "react";
import {
  Download,
  Eye,
  File,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Item } from "@astryxdesign/core/Item";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { List } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useSignedOut } from "@/components/AuthGate";
import { runArtifactUrl } from "@/lib/api";
import type { FileKind, ResultFileView } from "@/lib/run-files";
import styles from "./ResultFiles.module.css";

export const FILE_ICONS: Record<FileKind, LucideIcon> = {
  pdf: FileText,
  word: FileType,
  spreadsheet: FileSpreadsheet,
  text: FileText,
  audio: FileAudio,
  image: FileImage,
  other: File,
};

/**
 * Whether the window matches a media query, read where the page is shown. Before the page is read (and on a server)
 * it is taken to match: the wide layout, which is what a laptop shows first.
 */
export function useMediaMatch(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => true);
}

/** Where a PDF opens in a dialog and where in a tab of its own: a phone's width, then a laptop's. */
const TABLET = "(min-width: 640px)";
export const LAPTOP = "(min-width: 1024px)";

/** A link that saves the file it points at: `Button` passes the link it renders no `download`. */
export function DownloadLink(props: ComponentProps<"a">) {
  return <a {...props} download />;
}

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
    <VStack as="section" aria-labelledby="result-files" gap={3}>
      <Heading level={2} id="result-files">
        {title}
      </Heading>
      <Card padding={0}>
        <List className={styles.files}>
          {files.map((file) => {
            const download = runArtifactUrl(flowId, runId, file.fileId);
            return (
              <HStack key={file.fileId} as="li" wrap="wrap" vAlign="center" gap={2}>
                <Item className={styles.file} startContent={<Icon icon={FILE_ICONS[file.kind]} />} label={<Text>{file.name}</Text>} description={file.meta} />
                {file.available && (
                  <HStack wrap="wrap" gap={2} paddingInline={2} paddingBlockEnd={2}>
                    {file.previewable && (
                      <OpenFile file={file} url={runArtifactUrl(flowId, runId, file.fileId, true)} download={download} />
                    )}
                    <Button as={DownloadLink} href={download} icon={<Icon icon={Download} />} label={`Ladda ner ${file.name}`}>
                      Ladda ner
                    </Button>
                  </HStack>
                )}
              </HStack>
            );
          })}
        </List>
      </Card>
    </VStack>
  );
}

/**
 * A PDF opens in the browser's own viewer: in a titled dialog where there is
 * room for it, in a new tab on a phone. The dialog opens on its title with its
 * actions and Stäng before the viewer. The viewer is not in the Tab order: the
 * browser's PDF frame keeps Escape to itself and shows this page no focus state,
 * so keyboard users read the file with "Öppna i ny flik", in a whole tab.
 *
 * On the document's own row the file's name is the one control: a new tab below
 * a laptop's width, as Öppna PDF above the document does there, and the dialog
 * from it.
 */
export function OpenFile({
  file,
  url,
  download,
  name = false,
}: {
  file: ResultFileView;
  url: string;
  download: string;
  name?: boolean;
}) {
  const roomy = useMediaMatch(name ? LAPTOP : TABLET);
  const [open, setOpen] = useState(false);
  // While the login has ended the page is covered and the dialog, which a cover does not reach, is closed; it is
  // back when the login is, with its viewer and where it was.
  const covered = useSignedOut();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);

  // The dialog gives focus back to what had it when it opened. Safari and Firefox on a Mac do not focus a button
  // that is clicked, so what had focus was the page: the trigger gets it once the dialog is closed.
  useEffect(() => {
    if (wasOpen.current && !open) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const newTab = { href: url, target: "_blank", rel: "noopener noreferrer" } as const;
  if (!roomy) {
    return name ? (
      <Button {...newTab} variant="ghost" className={styles.name} endContent={<Icon icon="externalLink" />} label={`Öppna ${file.name} i en ny flik`}>
        {file.name}
      </Button>
    ) : (
      <Button {...newTab} icon={<Icon icon="externalLink" />} label={`Öppna ${file.name} i en ny flik`}>
        Öppna
      </Button>
    );
  }

  return (
    <>
      {name ? (
        <Button
          ref={trigger}
          variant="ghost"
          className={styles.name}
          aria-haspopup="dialog"
          endContent={<Icon icon={Eye} />}
          label={`Öppna ${file.name}`}
          onClick={() => setOpen(true)}
        >
          {file.name}
        </Button>
      ) : (
        <Button ref={trigger} aria-haspopup="dialog" icon={<Icon icon={Eye} />} label={`Öppna ${file.name}`} onClick={() => setOpen(true)}>
          Öppna
        </Button>
      )}
      {/* Mounted while it is closed, for the focus it gives back; the file is fetched only once it is open. */}
      <Dialog isOpen={open && !covered} onOpenChange={setOpen} width={1024} maxHeight="85dvh">
        <Layout
          header={
            <DialogHeader
              title={file.name}
              subtitle={file.meta}
              onOpenChange={setOpen}
              endContent={
                <>
                  <Button {...newTab} icon={<Icon icon="externalLink" />} label="Öppna i ny flik" />
                  <Button as={DownloadLink} href={download} icon={<Icon icon={Download} />} label="Ladda ner" />
                </>
              }
            />
          }
          content={
            <LayoutContent padding={0}>
              {open && <iframe src={url} title={file.name} tabIndex={-1} className={styles.viewer} />}
            </LayoutContent>
          }
        />
      </Dialog>
    </>
  );
}
