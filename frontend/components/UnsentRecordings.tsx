import { Download, Mic, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Heading } from "@astryxdesign/core/Heading";
import { useAnnounce, useMediaQuery } from "@astryxdesign/core/hooks";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ActionRow, STACKED } from "@/components/ActionRow";
import { IconTile } from "@/components/IconTile";
import styles from "./UnsentRecordings.module.css";
import { ProblemAlert } from "@/components/flow/ProblemAlert";
import { useSaveRecording } from "@/components/save-recording";
import { moveFocusToHeading } from "@/routes/RouteEffects";
import { formatDuration, recordingName } from "@/lib/format";
import {
  continuable,
  cutOff,
  filesIn,
  hasAudio,
  IN_USE_ELSEWHERE,
  recordingStore,
  type DeviceRefusal,
  type StoredRecording,
} from "@/lib/recording-store";

/**
 * An unsent recording as listed: `exportOnly` when this tab may only save it as a file, `elsewhere` while another tab
 * holds it (records, shows or sends it), when this one can do nothing with it, and `refused` when the device stopped
 * keeping it partway (the latest of it is then only in this tab).
 */
export type UnsentRecording = StoredRecording & { exportOnly?: boolean; elsewhere?: boolean; refused?: DeviceRefusal | null };

/** The user's unsent recordings as read from the device; `unreadable` when the device's store could not be read. */
export type UnsentList = { recordings: UnsentRecording[]; unreadable: boolean; retry: () => void };

/** The user's unsent recordings (of one flow, when given), kept current. */
export function useUnsentRecordings(ownerId: string, flowId?: string): UnsentList {
  const [recordings, setRecordings] = useState<UnsentRecording[]>([]);
  const [unreadable, setUnreadable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};
    void recordingStore().then((store) => {
      if (cancelled) return;
      const load = () =>
        store.listUnsentGroups(ownerId).then(
          ({ offered, elsewhere }) => {
            if (cancelled) return;
            setUnreadable(false);
            setRecordings(
              [
                ...offered.map((r) => ({ ...r, exportOnly: !store.mayChange(r.id), refused: store.refused(r.id) })),
                ...elsewhere.map((r) => ({ ...r, elsewhere: true })),
              ]
                .filter((r) => !flowId || r.flowId === flowId)
                .sort((a, b) => b.startedAt - a.startedAt),
            );
          },
          () => !cancelled && setUnreadable(true),
        );
      // Another tab that lets a recording go says nothing to this one: back in view, the list is read again.
      const shown = () => document.visibilityState === "visible" && void load();
      const unfollow = store.subscribe(() => void load());
      document.addEventListener("visibilitychange", shown);
      unsubscribe = () => {
        unfollow();
        document.removeEventListener("visibilitychange", shown);
      };
      void load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [ownerId, flowId, attempt]);
  return { recordings, unreadable, retry };
}

/** Whether the browser may delete this device's recordings (its storage is not persistent); false until it has said. */
export function useEvictable(): boolean {
  const [evictable, setEvictable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};
    void recordingStore().then((store) => {
      if (cancelled) return;
      setEvictable(store.evictable);
      unsubscribe = store.subscribe(() => setEvictable(store.evictable));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return evictable;
}

/** "Nämndmöte till rapport · 42 min": under the name the recording had when it was made. */
export function recordingDetails(
  recording: StoredRecording,
  { withFlowName = false }: { withFlowName?: boolean } = {},
): string {
  return [...(withFlowName ? [recording.flowName] : []), formatDuration(recording.durationMs)].join(" · ");
}

/**
 * The recording a reload cut off that this tab can record on in, the first when there are more: going on with it is the
 * likely next step. A stopped one can be recorded on in too (its row offers it), but sending it is the likelier.
 */
export function resumableRecording(recordings: UnsentRecording[]): UnsentRecording | undefined {
  return recordings.find((recording) => !recording.exportOnly && !recording.elsewhere && cutOff(recording));
}

/**
 * Recordings kept on this device that Eneo has not received yet; when the device cannot be read, a notice in
 * their place, so that the person is not left thinking there are none. They stand in a card
 * that leads with one recording: its tile, what it is and its actions. "Fortsätt spela in" on a recording a reload cut
 * off is the page's one filled action, unless the person has chosen another way (`filled` false). `folded` (the flow
 * list) leads with the latest a reload cut off before the newest, whose main action (going on with it, else sending it)
 * is then the page's filled one, and folds the rest away, so what follows stays in view.
 */
export function UnsentRecordings({
  list: { recordings, unreadable, retry },
  onSend,
  onContinue,
  filled = true,
  withFlowName = false,
  sendLabel,
  evictable = false,
  folded = false,
}: {
  list: UnsentList;
  /** Absent where the flow cannot run now: the recordings are then only saved as files or deleted. */
  onSend?: (recording: StoredRecording) => void;
  onContinue?: (recording: StoredRecording) => void;
  /** False once the person has chosen another way on the page (a file): the page's own action is then the filled one. */
  filled?: boolean;
  withFlowName?: boolean;
  /** What a recording's send says: what its flow makes (lib/flow-output createActionLabel). */
  sendLabel: (recording: StoredRecording) => string;
  /** The browser may delete the recordings (useEvictable): the list then does not promise they stay. */
  evictable?: boolean;
  folded?: boolean;
}) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const announce = useAnnounce();
  const narrow = useMediaQuery(STACKED);
  const tablet = useMediaQuery("(min-width: 768px)", true);
  const laptop = useMediaQuery("(min-width: 1024px)", true);
  // A removal takes the focus with its row. Once the list no longer has the recording, its heading takes the focus, saying
  // what is left, or with none left the page's; focus the person has put elsewhere since stays there.
  const listed = useRef(recordings);
  listed.current = recordings;
  const removed = useRef<string | null>(null);
  const afterRemoval = () => {
    const id = removed.current;
    if (id === null || listed.current.some((recording) => recording.id === id)) return;
    removed.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    if (listed.current.length > 0) heading.current?.focus();
    else moveFocusToHeading();
  };
  useEffect(afterRemoval, [recordings]);
  const onRemoved = (id: string) => {
    announce("Inspelningen togs bort.");
    removed.current = id;
    afterRemoval();
  };
  if (unreadable) {
    return (
      <ProblemAlert
        problem={{ title: "Kunde inte läsa inspelningar som inte skickats på den här enheten.", retry: true }}
        onRetry={retry}
      />
    );
  }
  if (recordings.length === 0) return null;
  const resumable = onContinue ? resumableRecording(recordings) : undefined;
  const cutOff = recordings.length === 1 && resumable !== undefined;
  // The card leads with one recording; the rest follow it, folded away on the flow list.
  const lead = folded ? (resumable ?? recordings[0]) : recordings[0];
  const rest = recordings.filter((recording) => recording !== lead);
  // Never folded away: one whose latest audio is only in this tab, which closing the tab would lose.
  const foldedAway = folded ? rest.filter((recording) => !recording.refused) : [];
  const inView = rest.filter((recording) => !foldedAway.includes(recording));
  // Where a send goes, said only where a row has one (UnsentRecordingRow): not for a recording another tab holds, one this
  // browser may only save as a file, or one without audio.
  const sendable = onSend !== undefined && recordings.some((recording) => hasAudio(recording) && !recording.exportOnly && !recording.elsewhere);
  const row = (recording: UnsentRecording, head?: ReactNode, note?: ReactNode) => (
    <UnsentRecordingRow
      key={recording.id}
      recording={recording}
      withFlowName={withFlowName}
      sendLabel={sendLabel(recording)}
      onSend={onSend}
      onContinue={continuable(recording) ? onContinue : undefined}
      onRemoved={onRemoved}
      primary={filled && (folded ? recording === lead : recording === resumable)}
      head={head}
      note={note}
    />
  );
  const head = (
    <Heading level={2} id={headingId} ref={heading} tabIndex={-1}>
      {cutOff
        ? "Inspelningen avbröts"
        : recordings.length === 1
          ? "En inspelning har inte skickats"
          : `${recordings.length} inspelningar har inte skickats`}
    </Heading>
  );
  // A named region (Section is no landmark), as the screen reader's list of landmarks has it, named by its heading, which
  // says what is left to do. On the flow list (folded) the card's content starts where the flow rows' does; above the
  // setup's working card, where that card's does (StateCard: 16, 24 and 32 px).
  return (
    <Card role="region" aria-labelledby={headingId} padding={folded ? (narrow ? 4 : 6) : laptop ? 8 : tablet ? 6 : 4}>
      <VStack gap={4}>
        {row(
          lead,
          head,
          <DeviceSentence
            cutOff={cutOff}
            count={recordings.length}
            evictable={evictable}
            sendable={sendable}
            refused={lead.refused ?? null}
            allKept={recordings.every((recording) => !recording.refused)}
          />,
        )}
        {inView.length > 0 && <List hasDividers>{inView.map((recording) => row(recording))}</List>}
        {foldedAway.length > 0 && (
          <Collapsible trigger={foldedAway.length === 1 ? "En inspelning till" : `${foldedAway.length} inspelningar till`} defaultIsOpen={false}>
            <List hasDividers>{foldedAway.map((recording) => row(recording))}</List>
          </Collapsible>
        )}
      </VStack>
    </Card>
  );
}

/** What a recording the device stopped keeping partway says: the latest of it is in this tab only. */
const tabOnly = (refused: DeviceRefusal) =>
  `${refused === "full" ? "Enheten är full, så det senaste" : "Det senaste"} av inspelningen finns bara i den här fliken. Stäng inte fliken.`;

/**
 * The device sentence under the heading: where the recordings are kept, and for how long. A recording the device stopped
 * keeping (`refused`, in this tab) is not said to be on the device: closing the tab on that word would lose its latest part.
 * Of several, they are said to be on the device only when all are (`allKept`); one that is not says so in its own row.
 */
function DeviceSentence({
  cutOff,
  count,
  evictable,
  sendable,
  refused,
  allKept,
}: {
  cutOff: boolean;
  count: number;
  evictable: boolean;
  sendable: boolean;
  refused: DeviceRefusal | null;
  allKept: boolean;
}) {
  if (!refused && count > 1 && !allKept) return null;
  return (
        <Text as="p" type="supporting" color="secondary" data-measure>
          {refused
            ? tabOnly(refused)
            : cutOff
            ? `Den fortsätter i samma inspelning när du väljer Fortsätt spela in.${sendable ? " När den har skickats till Eneo går det inte att fortsätta." : ""}`
            : count === 1
              ? evictable
                ? `Den finns på den här enheten. Webbläsaren kan ta bort den om du väntar länge med att skicka den${sendable ? " till Eneo" : ""}.`
                : `Den finns kvar på den här enheten tills den har skickats${sendable ? " till Eneo" : ""}.`
              : evictable
                ? `De finns på den här enheten. Webbläsaren kan ta bort dem om du väntar länge med att skicka dem${sendable ? " till Eneo" : ""}.`
                : `De finns kvar på den här enheten tills de har skickats${sendable ? " till Eneo" : ""}.`}
        </Text>
  );
}

function UnsentRecordingRow({
  recording,
  withFlowName,
  sendLabel,
  onSend,
  onContinue,
  onRemoved,
  primary,
  head,
  note,
}: {
  recording: UnsentRecording;
  withFlowName: boolean;
  sendLabel: string;
  onSend?: (recording: StoredRecording) => void;
  /** Given for a recording whose capture was cut off, where a recorder can take it over. */
  onContinue?: (recording: StoredRecording) => void;
  /** The device no longer has it. */
  onRemoved: (id: string) => void;
  /** Its main action (Fortsätt spela in, else the send) is the page's filled action. */
  primary: boolean;
  /** The card's heading, when this recording leads the card: the row is then the card's head, with its tile. */
  head?: ReactNode;
  /** The device sentence, under the leading recording's line. */
  note?: ReactNode;
}) {
  const summaryId = useId();
  const questionId = useId();
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  // No audio reached the device: nothing to send or save, only going on with it and deleting it.
  const audio = hasAudio(recording);
  const saving = useSaveRecording(recording.id, filesIn(recording));
  const stacked = useMediaQuery(STACKED);
  // The narrowest phones: the send's words without "av inspelningen", which would break inside the button. Its name keeps
  // them, and starts with the words shown (WCAG 2.5.3).
  const tiny = useMediaQuery("(max-width: 359.98px)");
  const lead = head !== undefined;
  // The leading recording's actions are the page's own size when one of them is its filled action.
  const size = lead && primary ? "lg" : "md";

  // Focus follows the question: to "Avbryt" when it opens, back to "Ta bort" when it closes.
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (wasConfirming.current) deleteRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  async function save() {
    setProblem(null);
    if (!(await saving.save())) setProblem("Inspelningen kunde inte sparas som fil. Försök igen.");
  }

  async function remove() {
    try {
      await (await recordingStore()).remove(recording.id);
      onRemoved(recording.id);
    } catch (error) {
      setConfirming(false);
      setProblem(
        error instanceof Error && error.message === IN_USE_ELSEWHERE
          ? IN_USE_ELSEWHERE
          : "Inspelningen kunde inte tas bort. Försök igen.",
      );
    }
  }

  const quietSave = audio && (
    <Button
      key="save"
      label={saving.label}
      variant="secondary"
      size={size}
      icon={<Icon icon={Download} size="sm" />}
      aria-describedby={summaryId}
      isLoading={saving.busy}
      isInterruptible
      onClick={() => void save()}
    />
  );
  // As tall as the actions beside it, so its hover and focus box is theirs; on a phone at the end of Spara ljudfil's row,
  // at its own width.
  const removeButton = (
    <Button
      ref={deleteRef}
      label="Ta bort"
      variant="ghost"
      size={size}
      icon={<Icon icon={Trash2} size="sm" />}
      aria-describedby={summaryId}
      onClick={() => setConfirming(true)}
      className={styles.quiet}
    />
  );
  // The ways on (going on with it, sending it), then saving it as a file (outlined), as the ready recording has them.
  const [first, ...outlined] = [
    onContinue && (
      <Button
        key="continue"
        label="Fortsätt spela in"
        variant={primary ? "primary" : "secondary"}
        size={size}
        aria-describedby={summaryId}
        onClick={() => onContinue(recording)}
      />
    ),
    onSend && audio && (
      <Button
        key="send"
        label={sendLabel}
        variant={primary && !onContinue ? "primary" : "secondary"}
        size={size}
        aria-describedby={summaryId}
        onClick={() => onSend(recording)}
      >
        {tiny ? sendLabel.replace(/ av inspelningen$/, "") : undefined}
      </Button>
    ),
    quietSave,
  ].filter(Boolean);
  const actions = recording.elsewhere ? (
    <Text as="p" color="secondary">
      {IN_USE_ELSEWHERE}
    </Text>
  ) : recording.exportOnly ? (
    // Without Web Locks another tab may still hold it: here it is only read, as a file when it has audio.
    audio && (
      <VStack gap={2} hAlign={stacked ? "stretch" : "start"}>
        <Text as="p" color="secondary">
          I den här webbläsaren kan den bara sparas som fil.
        </Text>
        <Button label={saving.label} aria-describedby={summaryId} isLoading={saving.busy} isInterruptible onClick={() => void save()} />
      </VStack>
    )
  ) : confirming ? null : stacked ? (
    // Up to 640 px (as ActionRow) the first across the card; the outlined ones after it share a row where they fit and
    // stand one under the other where they do not, so the flows stay in view under a card of a cut-off recording; Ta bort
    // ends their row at its own width, and goes under them where the row has no room for it.
    <VStack gap={2} hAlign="stretch">
      {first}
      <HStack gap={2} wrap="wrap" className={styles.outlined}>
        {outlined}
        {removeButton}
      </HStack>
    </VStack>
  ) : (
    // Wider all stand in one row, wrapping when they must, deleting last.
    <HStack gap={2} vAlign="center" wrap="wrap">
      {first}
      {outlined}
      {removeButton}
    </HStack>
  );
  const question = confirming && (
    <VStack role="group" aria-labelledby={questionId} gap={2}>
      <Text as="p" id={questionId}>
        Ta bort inspelningen från enheten? Det går inte att ångra.
      </Text>
      <ActionRow>
        <Button ref={cancelRef} label="Avbryt" onClick={() => setConfirming(false)} />
        <Button label="Ta bort" variant="destructive" onClick={() => void remove()} />
      </ActionRow>
    </VStack>
  );
  // Its name, flow and length. The name's date and time stay on one line and the length is one word (formatDuration); the
  // flow's name, which can be longer than a phone's line, wraps, and keeps the dot after it.
  const what = (
    <>
      <Text as="p" color="secondary" hasTabularNumbers>
        <span className={styles.part}>{recordingName(recording.startedAt)} ·</span> {withFlowName && `${recording.flowName}\u00a0· `}
        {formatDuration(recording.durationMs)}
      </Text>
      {!audio && <Text as="p">Inget ljud sparades i den här inspelningen.</Text>}
    </>
  );

  if (lead) {
    const words = (
      <VStack id={summaryId} gap={0.5}>
        {what}
      </VStack>
    );
    // The buttons stand beside the words; a sentence in their place (another tab has it, it can only be saved) under them.
    const buttons = recording.elsewhere || recording.exportOnly ? null : actions;
    // The card's head: the tile at the heading's line, the heading with what the recording is and where it is kept, and
    // the actions at the card's end where the line has room for both, under the words from their edge where it has not.
    // On a phone there is no tile: the heading, the words and the actions under it share the card's one edge.
    return (
      <VStack gap={4} data-recording="">
        {stacked ? (
          <>
            <VStack gap={1}>
              {head}
              {words}
              {note}
            </VStack>
            {actions}
            {question}
            {problem && <Banner status="error" title={problem} collapsible={false} />}
          </>
        ) : (
          <HStack gap={4} vAlign="start">
            <IconTile icon={Mic} size="lg" />
            <VStack gap={4} className={styles.lead}>
              <HStack gap={4} vAlign="center" hAlign="between" wrap="wrap">
                <VStack gap={1} className={styles.text}>
                  {head}
                  {words}
                  {note}
                </VStack>
                {buttons}
              </HStack>
              {!buttons && actions}
              {question}
              {problem && <Banner status="error" title={problem} collapsible={false} />}
            </VStack>
          </HStack>
        )}
      </VStack>
    );
  }

  // The recording, then what can be done with it, from the row's edge.
  return (
    <ListItem
      data-recording=""
      label={
        <VStack gap={3}>
          <HStack gap={3} align="start">
            <Icon icon="microphone" color="accent" />
            <VStack id={summaryId} gap={0.5}>
              <Text as="p" weight="semibold">
                {recordingName(recording.startedAt)}
              </Text>
              <Text as="p" color="secondary">
                {recordingDetails(recording, { withFlowName })}
              </Text>
              {!audio && <Text as="p">Inget ljud sparades i den här inspelningen.</Text>}
              {recording.refused && <Text as="p">{tabOnly(recording.refused)}</Text>}
            </VStack>
          </HStack>
          {actions}
          {question}
          {problem && <Banner status="error" title={problem} collapsible={false} />}
        </VStack>
      }
    />
  );
}
