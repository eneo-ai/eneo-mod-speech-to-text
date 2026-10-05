import { Download, FileText, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useSignedOut } from "@/components/AuthGate";
import { AudioPlayer, usePlayback } from "@/components/flow/AudioPlayer";
import { CopyButton } from "@/components/flow/CopyButton";
import { EarlierRuns } from "@/components/flow/EarlierRuns";
import { paragraphs } from "@/components/flow/LiveSheet";
import { ProblemAlert } from "@/components/flow/ProblemAlert";
import { StateCard } from "@/components/flow/StateCard";
import { saveRecordingAsFiles } from "@/components/save-recording";
import type { EarlierRunsSnapshot } from "@/lib/earlier-runs";
import type { LiveSession, Problem } from "@/lib/flow-session";
import { createActionLabel } from "@/lib/flow-output";
import { formatDuration, recordingName } from "@/lib/format";
import type { PlayerSource } from "@/lib/playback";
import { recordingStore, type StoredRecording } from "@/lib/recording-store";
import styles from "./ReadyPanel.module.css";

/** Each part of the recording as something the player can play, over its known length. */
function usePartSources(recording: StoredRecording): PlayerSource[] {
  const [sources, setSources] = useState<PlayerSource[]>([]);
  useEffect(() => {
    let cancelled = false;
    let urls: string[] = [];
    void recordingStore()
      .then((store) => store.readParts(recording.id))
      .then((files) => {
        if (cancelled) return;
        urls = files.map((file) => URL.createObjectURL(file.blob));
        setSources(
          files.map((file, i) => ({ url: urls[i], durationMs: recording.parts[file.index]?.durationMs ?? 0 })),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [recording]);
  return sources;
}

/** Strömma's live text after Stoppa, to read and copy until the document brings the final text. */
function LiveDraft({ live, makesText }: { live: LiveSession; makesText: boolean }) {
  const { pieces } = useSyncExternalStore(live.subscribe, live.getSnapshot, live.getSnapshot);
  const headingId = useId();
  const texts = paragraphs(pieces).map((group) => group.map((piece) => piece.text).join(" "));
  if (texts.length === 0) return null;
  return (
    <VStack gap={2}>
      <HStack gap={4} wrap="wrap" align="center" justify="between">
        <VStack gap={0.5}>
          <Heading level={3} id={headingId}>
            Preliminär text
          </Heading>
          <Text as="p" type="supporting">
            {makesText ? "Den slutliga texten skapas när du väljer Skapa text." : "Den slutliga texten skapas med dokumentet."}
          </Text>
        </VStack>
        <CopyButton text={texts.join("\n\n")} label="Kopiera" />
      </HStack>
      {/* Scrolls on its own, by keyboard too, so a long meeting's draft keeps the actions in reach. */}
      <VStack role="region" aria-labelledby={headingId} tabIndex={0} isScrollable gap={3} className={styles.draft}>
        {texts.map((text, index) => (
          <Text as="p" key={index}>
            {text}
          </Text>
        ))}
      </VStack>
    </VStack>
  );
}

/**
 * "Inspelningen är klar": the recording, named for people, with its length
 * and playback, and one primary next step. Nothing here reads as an upload.
 */
export function ReadyPanel({
  recording,
  persistent,
  problem,
  live = null,
  finishing = false,
  makesText = false,
  onCreate,
  onContinue,
  onDiscard,
  earlierRuns,
  onOpenRun,
  onMoreRuns,
}: {
  recording: StoredRecording;
  persistent: boolean | null;
  problem: Problem | null;
  /** Strömma's live text, kept after Stoppa. */
  live?: LiveSession | null;
  /** Strömma's final text is on its way: Skapa dokument waits for it. */
  finishing?: boolean;
  /** The flow ends in text, not a file: the action and the lines say text. */
  makesText?: boolean;
  onCreate: () => void;
  /** "Fortsätt spela in": offered when the recorder can add a part to a stopped recording. */
  onContinue?: () => void;
  onDiscard: () => void;
  /** Shown once Eneo turns out to have a run for the recording already. */
  earlierRuns?: EarlierRunsSnapshot;
  onOpenRun?: (runId: string) => void;
  onMoreRuns?: () => void;
}) {
  // Eneo already has it: the run is among the earlier runs, and the copy here can go.
  const sent = problem?.sent === true;
  const sources = usePartSources(recording);
  const playback = usePlayback(sources);
  const [saveProblem, setSaveProblem] = useState<Problem | null>(null);
  // The question is the page's: it is closed while the login has ended, and back with the same state after the new one.
  const [confirming, setConfirming] = useState(false);
  const signedOut = useSignedOut();
  // Answered, or closed with Escape: the focus is back on the button that asked. The dialog gives it back itself, but not
  // when a press did not focus the button (Safari, Firefox on macOS), nor after a new login, when it was asked again with
  // nothing of the page focused.
  const trigger = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (!confirming && wasConfirming.current) trigger.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);
  const name = recordingName(recording.startedAt);
  const made = makesText ? "texten är skapad" : "dokumentet är skapat";
  // Stopped a moment after it started, most likely by mistake: going on is the likely next step.
  const moment = onContinue !== undefined && recording.durationMs < 2_000;

  async function save() {
    setSaveProblem(null);
    try {
      await saveRecordingAsFiles(recording.id);
    } catch {
      setSaveProblem({ title: "Inspelningen kunde inte sparas som fil.", detail: "Försök igen." });
    }
  }

  return (
    <StateCard>
      <VStack gap={1}>
        <Heading level={2} data-phase-heading tabIndex={-1}>
          Inspelningen är klar
        </Heading>
        <Text as="p" color="secondary">
          {name} · {formatDuration(recording.durationMs)}
        </Text>
      </VStack>

      {sources.length > 0 && <AudioPlayer playback={playback} label={name} />}
      {live && <LiveDraft live={live} makesText={makesText} />}

      <HStack gap={4} wrap="wrap" align="center">
        <Button label="Spara som fil" variant="secondary" icon={<Icon icon={Download} size="sm" />} onClick={() => void save()} />
        <StackItem size="fill">
          <Text as="p" type="supporting">
            {persistent
              ? `Inspelningen finns kvar på enheten tills ${made}.`
              : `Inspelningen finns bara i den här fliken. Stäng inte fliken innan ${made}.`}
          </Text>
        </StackItem>
      </HStack>

      {saveProblem && <ProblemAlert problem={saveProblem} />}
      {problem && <ProblemAlert problem={problem} reveal />}
      {sent && earlierRuns && onOpenRun && <EarlierRuns list={earlierRuns} onOpen={onOpenRun} onMore={onMoreRuns} />}

      {moment && <Text as="p">Inspelningen blev mycket kort. Välj Fortsätt spela in om den stoppades av misstag.</Text>}
      <VStack gap={0}>
        <Grid columns={{ minWidth: 220, repeat: "fit" }} gap={3}>
          <Button
            variant={moment ? "secondary" : "primary"}
            size="lg"
            width="100%"
            label={createActionLabel(makesText)}
            icon={<Icon icon={FileText} size="md" />}
            // Not disabled, so focus stays on it; a press does nothing until the text is in (the session ignores it). The
            // name stays; the button shows a spinner meanwhile, and the line under it says why.
            isLoading={finishing}
            isInterruptible
            onClick={onCreate}
          />
          {onContinue && (
            <Button
              variant={moment ? "primary" : "secondary"}
              size="lg"
              width="100%"
              label="Fortsätt spela in"
              icon={<Icon icon="microphone" size="md" />}
              onClick={onContinue}
            />
          )}
        </Grid>
        {/* The words the button gives up for its spinner, said in a region that is there before they are. */}
        <Text as="p" type="supporting" role="status" className={finishing ? styles.finishing : undefined}>
          {finishing ? "Slutför texten…" : ""}
        </Text>
      </VStack>

      <HStack hAlign="start">
        <Button
          ref={trigger}
          label={sent ? "Ta bort inspelningen från enheten" : "Ta bort"}
          variant={sent ? "secondary" : "ghost"}
          icon={<Icon icon={Trash2} size="sm" />}
          onClick={() => setConfirming(true)}
        />
      </HStack>
      <AlertDialog
        isOpen={confirming && !signedOut}
        onOpenChange={setConfirming}
        title="Ta bort inspelningen?"
        description="Den går inte att få tillbaka."
        cancelLabel="Avbryt"
        actionLabel="Ta bort"
        onAction={() => {
          setConfirming(false);
          onDiscard();
        }}
      />
    </StateCard>
  );
}
