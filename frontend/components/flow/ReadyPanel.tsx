import { Download, FileText, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ActionRow } from "@/components/ActionRow";
import { useSignedOut } from "@/components/AuthGate";
import { AudioPlayer, usePlayback } from "@/components/flow/AudioPlayer";
import { CopyButton } from "@/components/flow/CopyButton";
import { EarlierRuns } from "@/components/flow/EarlierRuns";
import { StoppedWhileSignedOut } from "@/components/flow/Recorder";
import { paragraphs } from "@/components/flow/LiveSheet";
import { ProblemAlert } from "@/components/flow/ProblemAlert";
import { StateCard } from "@/components/flow/StateCard";
import { useSaveRecording } from "@/components/save-recording";
import type { EarlierRunsSnapshot } from "@/lib/earlier-runs";
import type { LiveSession, Problem } from "@/lib/flow-session";
import { createActionLabel } from "@/lib/flow-output";
import { formatDuration, recordingName } from "@/lib/format";
import type { PlayerSource } from "@/lib/playback";
import { END_UNCONFIRMED } from "@/lib/recording-session";
import { filesIn, hasAudio, recordingStore, type StoredRecording } from "@/lib/recording-store";
import styles from "./ReadyPanel.module.css";

/** How long a recording's addresses outlive the player that read them. */
const RELEASE_AFTER_MS = 1_000;

/** Each part of the recording as something the player can play, over its known length; `unreadable` when the device could not be read. */
function usePartSources(recording: StoredRecording): { sources: PlayerSource[]; unreadable: boolean } {
  const [sources, setSources] = useState<PlayerSource[]>([]);
  const [unreadable, setUnreadable] = useState(false);
  // The audio is read again only when it changes: the stored recording is a new object whenever anything about it is
  // written (an uploaded part's file id, the send), and an address taken away while the player still loads it is an
  // error in Safari ("WebKitBlobResource error 1"), and a player that starts over.
  const audio = `${recording.id}|${recording.parts.map((part) => `${part.index}:${part.durationMs}:${part.bytes}:${part.chunks}`).join(",")}`;
  useEffect(() => {
    let cancelled = false;
    let urls: string[] = [];
    void recordingStore()
      .then((store) => store.readParts(recording.id))
      .then((files) => {
        if (cancelled) return;
        urls = files.map((file) => URL.createObjectURL(file.blob));
        setUnreadable(false);
        setSources(
          files.map((file, i) => ({ url: urls[i], durationMs: recording.parts[file.index]?.durationMs ?? 0 })),
        );
      })
      .catch(() => !cancelled && setUnreadable(true));
    return () => {
      cancelled = true;
      // A moment later: Safari may still be ending the player's read of an address when the player lets it go, and an
      // address taken away under that read is an error.
      const used = urls;
      setTimeout(() => used.forEach((url) => URL.revokeObjectURL(url)), RELEASE_AFTER_MS);
    };
    // `audio` stands for the recording's id and parts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audio]);
  return { sources, unreadable };
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
  finishQueued = false,
  makesText = false,
  forwarded = null,
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
  /** Skapa dokument was pressed meanwhile: it is made as soon as the final text is in. */
  finishQueued?: boolean;
  /** The flow ends in text, not a file: the action and the lines say text. */
  makesText?: boolean;
  /** Where the result goes on to a receiver: said above the action that sends it (`forwardedLine`). */
  forwarded?: string | null;
  /** Absent while the flow cannot run: the recording is then saved as a file or deleted, under the reason (`problem`). */
  onCreate?: () => void;
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
  const { sources, unreadable } = usePartSources(recording);
  const playback = usePlayback(sources);
  const saving = useSaveRecording(recording.id, filesIn(recording));
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
  // No audio reached the device: nothing to make or save, only going on and deleting.
  const audio = hasAudio(recording);
  const awaitingStop = recording.parts.some((part) => part.endConfirmed === false);
  const create = audio && !awaitingStop ? onCreate : undefined;
  // Stopped a moment after it started, most likely by mistake, or with nothing kept: going on is the likely next step.
  const moment = onContinue !== undefined && (recording.durationMs < 2_000 || !audio);
  const createButton = create && (
    <Button
      key="create"
      variant={moment ? "secondary" : "primary"}
      size="lg"
      label={createActionLabel(makesText)}
      icon={<Icon icon={FileText} size="md" />}
      // Not disabled, so focus stays on it; a press does nothing until the text is in (the session ignores it). The
      // name stays; the button shows a spinner meanwhile, and the line under it says why.
      isLoading={finishing}
      isInterruptible
      onClick={create}
    />
  );
  const continueButton = onContinue && (
    <Button
      key="continue"
      variant={moment ? "primary" : "secondary"}
      size="lg"
      label="Fortsätt spela in"
      icon={<Icon icon="microphone" size="md" />}
      onClick={onContinue}
    />
  );

  async function save() {
    setSaveProblem(null);
    if (!(await saving.save())) setSaveProblem({ title: "Inspelningen kunde inte sparas som fil.", detail: "Försök igen." });
  }

  return (
    <StateCard>
      <StoppedWhileSignedOut />
      <VStack gap={1}>
        <Heading level={2} data-phase-heading tabIndex={-1}>
          Inspelningen är klar
        </Heading>
        <Text as="p" color="secondary">
          {name} · {formatDuration(recording.durationMs)}
        </Text>
      </VStack>

      {sources.length > 0 && <AudioPlayer playback={playback} label={name} />}
      {unreadable && <ProblemAlert problem={{ title: "Inspelningen kunde inte läsas på den här enheten, så den kan inte spelas upp." }} />}
      {live && <LiveDraft live={live} makesText={makesText} />}

      {audio ? (
        <HStack gap={4} wrap="wrap" align="center">
          <Button
            label={saving.label}
            variant="secondary"
            icon={<Icon icon={Download} size="sm" />}
            isLoading={saving.busy}
            isInterruptible
            onClick={() => void save()}
          />
          <StackItem size="fill">
            <Text as="p" type="supporting">
              {persistent
                ? `Inspelningen finns kvar på enheten tills ${made}.`
                : `Inspelningen finns bara i den här fliken. Stäng inte fliken innan ${made}.`}
            </Text>
          </StackItem>
        </HStack>
      ) : (
        <Text as="p">Inget ljud sparades i den här inspelningen.</Text>
      )}

      {saveProblem && <ProblemAlert problem={saveProblem} />}
      {awaitingStop && <ProblemAlert problem={{ title: "Webbläsaren har inte bekräftat inspelningens stopp.", detail: "Spara ljudet som fil för att behålla det. Du kan sedan ladda upp filen i en ny inspelning." }} />}
      {problem && !(awaitingStop && problem.title === END_UNCONFIRMED) && <ProblemAlert problem={problem} reveal />}
      {sent && earlierRuns && onOpenRun && <EarlierRuns list={earlierRuns} onOpen={onOpenRun} onMore={onMoreRuns} />}

      {moment && audio && <Text as="p">Inspelningen blev mycket kort. Välj Fortsätt spela in om den stoppades av misstag.</Text>}
      {create && forwarded && <Text as="p" type="supporting">{forwarded}</Text>}
      {(create || onContinue) && (
        <VStack gap={0}>
          {/* Which one is main follows the recording: a very short one was most likely stopped by mistake. */}
          <ActionRow>
            {(moment ? [createButton, continueButton] : [continueButton, createButton]).filter(Boolean)}
          </ActionRow>
          {/* The words the button gives up for its spinner, said in a region that is there before they are. */}
          <Text as="p" type="supporting" role="status" className={finishing ? styles.finishing : undefined}>
            {finishing ? (finishQueued ? "Slutför texten… Det skapas så snart den är klar." : "Slutför texten…") : ""}
          </Text>
        </VStack>
      )}

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
