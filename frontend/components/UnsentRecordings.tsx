import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Heading } from "@astryxdesign/core/Heading";
import { useAnnounce, useMediaQuery } from "@astryxdesign/core/hooks";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ActionRow, STACKED } from "@/components/ActionRow";
import { ProblemAlert } from "@/components/flow/ProblemAlert";
import { useSaveRecording } from "@/components/save-recording";
import { moveFocusToHeading } from "@/routes/RouteEffects";
import { formatDuration, recordingName } from "@/lib/format";
import {
  continuable,
  filesIn,
  hasAudio,
  IN_USE_ELSEWHERE,
  recordingStore,
  type StoredRecording,
} from "@/lib/recording-store";

/**
 * An unsent recording as listed: `exportOnly` when this tab may only save it as a file, `elsewhere` while another tab
 * holds it (records, shows or sends it), when this one can do nothing with it.
 */
export type UnsentRecording = StoredRecording & { exportOnly?: boolean; elsewhere?: boolean };

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
                ...offered.map((r) => ({ ...r, exportOnly: !store.mayChange(r.id) })),
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

/** The recording a reload cut off that this tab can record on in, the first when there are more. */
export function resumableRecording(recordings: UnsentRecording[]): UnsentRecording | undefined {
  return recordings.find((recording) => !recording.exportOnly && !recording.elsewhere && continuable(recording));
}

/**
 * Recordings kept on this device that Eneo has not received yet; when the device cannot be read, a notice in
 * their place, so that the person is not left thinking there are none. "Fortsätt spela in" on a recording a reload cut
 * off is the page's one filled action, unless the person has chosen another way (`filled` false). `folded` (the flow
 * list) shows one, the latest a reload cut off before the newest, and folds the rest away, so what follows stays in view.
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
  const shown = folded ? (resumable ?? recordings[0]) : null;
  const rest = recordings.filter((recording) => shown !== null && recording !== shown);
  // Where a send goes, said only where a row has one (UnsentRecordingRow): not for a recording another tab holds, one this
  // browser may only save as a file, or one without audio.
  const sendable = onSend !== undefined && recordings.some((recording) => hasAudio(recording) && !recording.exportOnly && !recording.elsewhere);
  const row = (recording: UnsentRecording) => (
    <UnsentRecordingRow
      key={recording.id}
      recording={recording}
      withFlowName={withFlowName}
      sendLabel={sendLabel(recording)}
      onSend={onSend}
      onContinue={continuable(recording) ? onContinue : undefined}
      onRemoved={onRemoved}
      primary={filled && recording === resumable}
    />
  );
  // A named region (Section is no landmark), as the screen reader's list of landmarks has it.
  return (
    <VStack role="region" aria-labelledby={headingId} gap={3}>
      <VStack gap={1}>
        <Heading level={2} id={headingId} ref={heading} tabIndex={-1}>
          {cutOff
            ? "Inspelningen avbröts"
            : recordings.length === 1
              ? "En inspelning har inte skickats"
              : `${recordings.length} inspelningar har inte skickats`}
        </Heading>
        <Text as="p" color="secondary">
          {cutOff
            ? `Den fortsätter i samma inspelning när du väljer Fortsätt spela in.${sendable ? " När den har skickats till Eneo går det inte att fortsätta." : ""}`
            : recordings.length === 1
              ? evictable
                ? `Den finns på den här enheten. Webbläsaren kan ta bort den om du väntar länge med att skicka den${sendable ? " till Eneo" : ""}.`
                : `Den finns kvar på den här enheten tills den har skickats${sendable ? " till Eneo" : ""}.`
              : evictable
                ? `De finns på den här enheten. Webbläsaren kan ta bort dem om du väntar länge med att skicka dem${sendable ? " till Eneo" : ""}.`
                : `De finns kvar på den här enheten tills de har skickats${sendable ? " till Eneo" : ""}.`}
        </Text>
      </VStack>
      <List hasDividers>{shown ? row(shown) : recordings.map(row)}</List>
      {rest.length > 0 && (
        <Collapsible trigger={rest.length === 1 ? "En inspelning till" : `${rest.length} inspelningar till`} defaultIsOpen={false}>
          <List hasDividers>{rest.map(row)}</List>
        </Collapsible>
      )}
    </VStack>
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
}: {
  recording: UnsentRecording;
  withFlowName: boolean;
  sendLabel: string;
  onSend?: (recording: StoredRecording) => void;
  /** Given for a recording whose capture was cut off, where a recorder can take it over. */
  onContinue?: (recording: StoredRecording) => void;
  /** The device no longer has it. */
  onRemoved: (id: string) => void;
  /** Its "Fortsätt spela in" is the page's filled action. */
  primary: boolean;
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

  // The recording, then what can be done with it, from the row's edge.
  return (
    <ListItem
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
            </VStack>
          </HStack>
          {recording.elsewhere ? (
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
          ) : confirming ? (
            <VStack role="group" aria-labelledby={questionId} gap={2}>
              <Text as="p" id={questionId}>
                Ta bort inspelningen från enheten? Det går inte att ångra.
              </Text>
              <ActionRow>
                <Button ref={cancelRef} label="Avbryt" onClick={() => setConfirming(false)} />
                <Button label="Ta bort" variant="destructive" onClick={() => void remove()} />
              </ActionRow>
            </VStack>
          ) : (
            // Up to 640 px (as ActionRow) the actions stack across the card, one edge for all; wider they stand in one row at
            // their own widths, wrapping when they must. Deleting comes last, in its quieter style.
            <Stack
              direction={stacked ? "vertical" : "horizontal"}
              gap={2}
              hAlign={stacked ? "stretch" : "start"}
              wrap={stacked ? "nowrap" : "wrap"}
            >
              {onContinue && (
                <Button
                  label="Fortsätt spela in"
                  variant={primary ? "primary" : "secondary"}
                  aria-describedby={summaryId}
                  onClick={() => onContinue(recording)}
                />
              )}
              {onSend && audio && <Button label={sendLabel} aria-describedby={summaryId} onClick={() => onSend(recording)} />}
              {audio && (
                <Button label={saving.label} aria-describedby={summaryId} isLoading={saving.busy} isInterruptible onClick={() => void save()} />
              )}
              <Button
                ref={deleteRef}
                label="Ta bort"
                variant="ghost"
                icon={<Icon icon={Trash2} size="sm" />}
                aria-describedby={summaryId}
                onClick={() => setConfirming(true)}
              />
            </Stack>
          )}
          {problem && <Banner status="error" title={problem} collapsible={false} />}
        </VStack>
      }
    />
  );
}
