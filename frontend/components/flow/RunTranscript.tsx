import { Download, RotateCcw } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { TranscriptPlayer } from "@/components/TranscriptPlayer";
import { useConfirmedWords } from "@/components/useConfirmedWords";
import { useTranscriptContext } from "@/components/useTranscriptContext";
import type { TranscriptContext } from "@/lib/transcript-context";
import { useTranscriptCorrections } from "@/components/useTranscriptCorrections";
import { inputFileAudioUrl, type FlowRunStep } from "@/lib/api";
import type { Playback } from "@/lib/playback";
import { confirmedWordsStorageKey } from "@/lib/confirmed-words";
import { renderReviewedTranscript } from "@/lib/transcript-corrections";
import { CopyButton } from "./CopyButton";
import styles from "./RunTranscript.module.css";

function downloadText(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** The run's transcript, its confirmed words and its corrections: read once, shared by the page that shows them. */
export function useRunTranscript(flowId: string, runId: string, steps: readonly FlowRunStep[], enabled = true) {
  const [transcript, , reload] = useTranscriptContext({ flowId, runId, enabled, steps });
  const [confirmedWords] = useConfirmedWords(
    transcript.stepId ? confirmedWordsStorageKey(flowId, runId, transcript.stepId) : null,
  );
  const editing = useTranscriptCorrections(flowId, runId, transcript);
  return { transcript, confirmedWords, editing, reload };
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
  const { transcript, confirmedWords, editing, reload } = useRunTranscript(flowId, runId, steps);
  return (
    <RunTranscriptView
      flowId={flowId}
      runId={runId}
      fileName={fileName}
      transcript={transcript}
      confirmedWords={confirmedWords}
      editing={editing}
      onReload={reload}
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
}: {
  flowId: string;
  runId: string;
  fileName: string;
  /** The page's playback, when it shows the recording's controls elsewhere too. */
  playback?: Playback;
  transcript: TranscriptContext;
  confirmedWords: ReadonlySet<string>;
  editing: ReturnType<typeof useTranscriptCorrections>;
  /** Reads the transcript and its saved corrections again. */
  onReload: () => void;
}) {
  const { corrections, saveState, localError, onCorrectionsChange, retryCorrections, downloadUnsavedCorrections } = editing;

  if (transcript.pending) {
    return (
      <VStack gap={3} aria-hidden>
        <Skeleton width={128} height={24} />
        <Skeleton height={192} />
      </VStack>
    );
  }
  if (transcript.segments.length === 0 && transcript.speakerReviews.length === 0) {
    // Nothing to show is only nothing to say when nothing went wrong reading it.
    if (!transcript.correctionProblem) return null;
    return (
      <VStack as="section" aria-labelledby="run-transcript" gap={3} hAlign="start">
        <Heading level={2} id="run-transcript">
          Transkript
        </Heading>
        <Banner status="error" collapsible={false} title={transcript.correctionProblem} />
        <Button icon={<Icon icon={RotateCcw} />} label="Läs in igen" onClick={onReload} />
      </VStack>
    );
  }

  const plain = renderReviewedTranscript(transcript.segments, corrections, transcript.speakerNames);
  // Unread or unreadable saved corrections, or only the start of a longer transcript: an export now
  // would silently drop the corrections or pass the start off as the whole.
  const unread = Boolean(transcript.correctionProblem) || transcript.textPreview;

  return (
    // From a laptop's width the card keeps to the window and its text scrolls inside it, the player docked below.
    <Card padding={0} role="region" aria-labelledby="run-transcript" className={styles.card}>
      <HStack hAlign="between" vAlign="center" wrap="wrap" gap={2} paddingInline={4} paddingBlockStart={3} paddingBlockEnd={2}>
        <Heading level={2} id="run-transcript">
          Transkript
        </Heading>
        <HStack wrap="wrap" gap={1}>
          <CopyButton text={plain} variant="ghost" size="sm" label="Kopiera" name="Kopiera transkriptet" isDisabled={unread} />
          <Button
            variant="ghost"
            size="sm"
            isDisabled={unread}
            icon={<Icon icon={Download} />}
            label="Ladda ner som text, transkriptet"
            onClick={() => downloadText(plain, fileName)}
          >
            Ladda ner som text
          </Button>
        </HStack>
      </HStack>
      {(unread || localError || saveState === "error") && (
        <VStack gap={2} hAlign="start" paddingInline={4} paddingBlockEnd={3}>
          {unread && (
            <HStack wrap="wrap" vAlign="center" gap={3}>
              <Text color="secondary">
                {transcript.textPreview
                  ? "Förhandsvisning, hela transkriptet kunde inte hämtas."
                  : "Transkriptet kan kopieras och laddas ner när rättningarna har lästs in."}
              </Text>
              <Button size="sm" icon={<Icon icon={RotateCcw} />} label="Läs in igen" onClick={onReload} />
            </HStack>
          )}
          {localError && <Banner status="error" collapsible={false} title={localError} />}
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
        downloadable={false}
        playback={playback}
      />
    </Card>
  );
}
