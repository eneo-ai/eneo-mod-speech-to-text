import { Download, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { TranscriptPlayer } from "@/components/TranscriptPlayer";
import { useConfirmedWords } from "@/components/useConfirmedWords";
import { useTranscriptContext } from "@/components/useTranscriptContext";
import type { TranscriptContext } from "@/lib/transcript-context";
import { useTranscriptCorrections } from "@/components/useTranscriptCorrections";
import { inputFileAudioUrl, type FlowRunStep } from "@/lib/api";
import type { SavedCorrections } from "@/lib/follow-run";
import type { Playback } from "@/lib/playback";
import { useAuthenticatedUser } from "@/components/AuthGate";
import { confirmedWordsStorageKey } from "@/lib/confirmed-words";
import { downloadBlob } from "@/lib/download";
import { renderReviewedTranscript } from "@/lib/transcript-corrections";
import { CopyButton, useCopy } from "./CopyButton";
import { useRoomInRow } from "./useRoomInRow";
import styles from "./RunTranscript.module.css";

/**
 * The run's transcript, its confirmed words and its corrections: read once, shared by the page that shows them, and read
 * again through the corrections (`editing.readAgain`), which a read replaces.
 */
export function useRunTranscript(
  flowId: string,
  runId: string,
  steps: readonly FlowRunStep[],
  enabled = true,
  savedCorrections?: SavedCorrections,
) {
  const user = useAuthenticatedUser();
  const [transcript, reload] = useTranscriptContext({ flowId, runId, enabled, steps, savedCorrections });
  const [confirmedWords] = useConfirmedWords(
    transcript.stepId ? confirmedWordsStorageKey(user.id, flowId, runId, transcript.stepId) : null,
  );
  const editing = useTranscriptCorrections(flowId, runId, transcript, reload);
  return { transcript, confirmedWords, editing };
}

/**
 * The run's transcript on its own: readable, with speakers when labelled, the
 * recording to listen to, and copy and download (.txt).
 */
export function RunTranscript({
  flowId,
  runId,
  steps,
  fileName,
}: {
  flowId: string;
  runId: string;
  /** The step results, read once when the run ended. */
  steps: readonly FlowRunStep[];
  /** The .txt the download saves, see transcriptFileName. */
  fileName: string;
}) {
  const { transcript, confirmedWords, editing } = useRunTranscript(flowId, runId, steps);
  const user = useAuthenticatedUser();
  return (
    <RunTranscriptView
      flowId={flowId}
      runId={runId}
      ownerId={user.id}
      fileName={fileName}
      transcript={transcript}
      confirmedWords={confirmedWords}
      editing={editing}
      onReload={editing.readAgain}
    />
  );
}

/** What RunTranscript shows once its data is read; its own component so a test can give it any state. */
export function RunTranscriptView({
  flowId,
  runId,
  fileName,
  transcript,
  confirmedWords,
  editing,
  onReload,
  playback,
  naming,
  ownerId,
  headingHidden = false,
}: {
  flowId: string;
  runId: string;
  fileName: string;
  /** Under the result's tabs (below a laptop's width): the tab "Transkribering" names the card, so its heading is only
   *  heard, and its copy and download join the player's first row. */
  headingHidden?: boolean;
  /** The page's playback, when it shows the recording's controls elsewhere too. */
  playback?: Playback;
  transcript: TranscriptContext;
  confirmedWords: ReadonlySet<string>;
  editing: ReturnType<typeof useTranscriptCorrections>;
  /** Reads the transcript and its saved corrections again. */
  onReload: () => void;
  /**
   * The run is finished, so its speakers can be named: where names typed and not saved are kept, and what the run made
   * (`thing`, as outputWords says it), whether it was sent on, whether it has a document to make again, and the people
   * it was started with.
   */
  naming?: { draftKey: { ownerId: string; name: string }; thing: string; delivered: boolean; hasDocument: boolean; participants: readonly string[] };
  /** The signed-in person, whose choices this browser keeps for the transcript's player (its letter keys). */
  ownerId?: string;
}) {
  const { corrections, saveState, localError, hasDropped, onCorrectionsChange, saveNow, retryCorrections, downloadUnsavedCorrections, downloadDropped } = editing;

  if (transcript.pending) {
    return (
      <VStack gap={3} aria-hidden>
        <Skeleton width={128} height={24} />
        <Skeleton height={192} />
      </VStack>
    );
  }
  if (transcript.segments.length === 0 && transcript.speakerReviews.length === 0) {
    // Read, and empty: text without timings is parsed into passages too, so the audio held no speech. Said where the
    // transcript stands (its tab, its column), not left as an empty panel.
    return (
      <VStack as="section" aria-labelledby="run-transcript" gap={3} hAlign="start">
        <Heading level={2} id="run-transcript" tabIndex={-1}>
          Transkribering
        </Heading>
        {transcript.correctionProblem ? (
          <>
            <Banner status="error" collapsible={false} title={transcript.correctionProblem} />
            <Button icon={<Icon icon={RotateCcw} />} label="Läs in igen" onClick={onReload} />
          </>
        ) : (
          <Text as="p" color="secondary">
            Inget tal hittades i ljudet.
          </Text>
        )}
      </VStack>
    );
  }

  const plain = renderReviewedTranscript(transcript.segments, corrections, transcript.speakerNames);
  // Unread or unreadable saved corrections, or only the start of a longer transcript: an export now
  // would silently drop the corrections or pass the start off as the whole.
  const unread = Boolean(transcript.correctionProblem) || transcript.textPreview;
  const download = () => downloadBlob(new Blob([plain], { type: "text/plain;charset=utf-8" }), fileName);
  const actions = (fits: boolean) => <TranscriptActions plain={plain} unread={unread} onDownload={download} fits={fits} />;

  return (
    // From a laptop's width the card keeps to the window and its text scrolls inside it, the player docked below.
    <Card padding={0} role="region" aria-labelledby="run-transcript" className={styles.card}>
      {/* Under the result's tabs the tab names the card, so its heading is only heard, and its copy and download join the
          player's first row (the speakers' row where they can be named) rather than take a row of their own. The heading
          takes the focus when a link leads to it (a failed run's "Gå till transkriberingen"). */}
      {headingHidden ? (
        <VisuallyHidden as="h2" id="run-transcript" tabIndex={-1}>
          Transkribering
        </VisuallyHidden>
      ) : (
        <TranscriptHeader actions={actions} />
      )}
      {/* Quiet, since the transcript is whole: only the click on a word cannot find its moment. */}
      {transcript.wordTimingFailed && transcript.fileIds.length > 0 && !unread && (
        <HStack paddingInline={3} paddingBlockEnd={2} className={styles.inset}>
          <Text as="p" type="supporting">
            Ordtiderna kunde inte tas fram den här gången. Ett klick i texten spelar från början av avsnittet.
          </Text>
        </HStack>
      )}
      {(unread || localError || saveState === "error" || hasDropped) && (
        <VStack gap={2} hAlign="start" paddingInline={3} paddingBlockEnd={3} className={styles.inset}>
          {unread && (
            <HStack wrap="wrap" vAlign="center" gap={3}>
              <Text color="secondary">
                {transcript.textPreview
                  ? "Förhandsvisning, hela transkriberingen kunde inte hämtas."
                  : "Transkriberingen kan kopieras och laddas ner när rättningarna har lästs in."}
              </Text>
              <Button size="sm" icon={<Icon icon={RotateCcw} />} label="Läs in igen" onClick={onReload} />
            </HStack>
          )}
          {localError && <Banner status="error" collapsible={false} title={localError} />}
          {hasDropped && <Button variant="ghost" size="sm" label="Hämta dina rättningar" onClick={downloadDropped} />}
          {saveState === "error" && (
            <HStack wrap="wrap" gap={2}>
              <Button size="sm" label="Försök spara igen" onClick={retryCorrections} />
              <Button variant="ghost" size="sm" label="Hämta osparade rättningar" onClick={downloadUnsavedCorrections} />
            </HStack>
          )}
        </VStack>
      )}
      <TranscriptPlayer
        className={styles.player}
        segments={transcript.segments}
        speakerReviews={transcript.speakerReviews}
        correctionProblem={transcript.correctionProblem}
        fileCount={transcript.fileIds.length}
        audioSrcFor={(fileIndex) => inputFileAudioUrl(flowId, runId, transcript.fileIds[fileIndex] ?? "")}
        speakerNames={transcript.speakerNames}
        textFallback=""
        corrections={corrections}
        editable={transcript.fromMetadata}
        onCorrectionsChange={onCorrectionsChange}
        saveState={saveState}
        confirmedWords={confirmedWords}
        playback={playback}
        naming={naming && { description: namingDescription(naming), draftKey: naming.draftKey, save: saveNow, participants: naming.participants }}
        ownerId={ownerId}
        actions={headingHidden ? actions : undefined}
      />
    </Card>
  );
}

/**
 * What naming after the run changes, said in its dialog: the transcript, its copy and its download at once (said by
 * their actions, never "texten", which a flow that makes text calls its result); the document only when it is made
 * again, and one already sent on not at all.
 */
function namingDescription({ thing, delivered, hasDocument }: { thing: string; delivered: boolean; hasDocument: boolean }): string {
  const later = delivered
    ? " Dokumentet som redan har skickats ändras inte."
    : hasDocument
      ? ` ${thing[0].toUpperCase() + thing.slice(1)} får namnen när du skapar ${thing === "texten" ? "den" : "det"} igen.`
      : "";
  return `Lyssna på ett exempel och skriv vem som talar. Namnen syns direkt i transkriberingen, även när du kopierar den eller laddar ner den som text.${later}`;
}

/**
 * The transcript's heading with its copy and download beside it, where the header has room, else folded into one menu
 * (the column of a narrow laptop), as the document's own actions fold. The heading takes the focus when a link leads to
 * it (a failed run's "Gå till transkriberingen").
 */
function TranscriptHeader({ actions }: { actions: (fits: boolean) => ReactNode }) {
  const room = useRoomInRow();
  return (
    <HStack ref={room.ref} hAlign="between" vAlign="center" wrap="wrap" gap={2} paddingInline={3} paddingBlockStart={4} paddingBlockEnd={3} className={styles.inset}>
      <Heading level={2} id="run-transcript" tabIndex={-1}>
        Transkribering
      </Heading>
      {actions(room.fits)}
    </HStack>
  );
}

/** Kopiera and Ladda ner som text: one line where its row has room for it (`fits`), else the menu. The two never wrap under
 *  each other, so the row measures what one line needs. */
function TranscriptActions({ plain, unread, onDownload, fits }: { plain: string; unread: boolean; onDownload: () => void; fits: boolean }) {
  return fits ? (
    <HStack gap={2} className={styles.trailing}>
      <CopyButton text={plain} variant="ghost" size="sm" label="Kopiera" name="Kopiera transkriberingen" isDisabled={unread} />
      <Button
        variant="ghost"
        size="sm"
        isDisabled={unread}
        icon={<Icon icon={Download} />}
        label="Ladda ner som text, transkriberingen"
        onClick={onDownload}
      >
        Ladda ner som text
      </Button>
    </HStack>
  ) : (
    <TranscriptMenu plain={plain} unread={unread} onDownload={onDownload} />
  );
}

/** The menu's copy confirms with a check on the menu's button; one that fails says so beside it, as the copy button does. */
function TranscriptMenu({ plain, unread, onDownload }: { plain: string; unread: boolean; onDownload: () => void }) {
  const [copyState, copy] = useCopy(plain);
  return (
    <HStack gap={2} vAlign="center">
      {copyState === "failed" && <Text type="supporting">Kunde inte kopiera</Text>}
      <DropdownMenu
        button={{
          label: "Fler alternativ för transkriberingen",
          isIconOnly: true,
          variant: "ghost",
          isDisabled: unread,
          icon: <Icon icon={copyState === "copied" ? "check" : "moreHorizontal"} />,
        }}
        hasChevron={false}
        alignment="end"
      >
        <DropdownMenuItem icon="copy" label="Kopiera transkriberingen" onClick={() => void copy()} />
        <DropdownMenuItem icon={Download} label="Ladda ner som text" onClick={onDownload} />
      </DropdownMenu>
    </HStack>
  );
}
