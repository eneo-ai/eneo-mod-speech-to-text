import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ProblemAlert } from "@/components/flow/ProblemAlert";
import { saveRecordingAsFiles } from "@/components/save-recording";
import { formatDuration, recordingName } from "@/lib/format";
import {
  continuable,
  IN_USE_ELSEWHERE,
  recordingStore,
  type StoredRecording,
} from "@/lib/recording-store";

/** An unsent recording as listed: `exportOnly` when this tab may only save it as a file. */
export type UnsentRecording = StoredRecording & { exportOnly?: boolean };

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
        store.listUnsent(ownerId).then(
          (all) => {
            if (cancelled) return;
            setUnreadable(false);
            setRecordings(
              (flowId ? all.filter((r) => r.flowId === flowId) : all).map((r) => ({
                ...r,
                exportOnly: !store.mayChange(r.id),
              })),
            );
          },
          () => !cancelled && setUnreadable(true),
        );
      unsubscribe = store.subscribe(() => void load());
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
  return recordings.find((recording) => !recording.exportOnly && continuable(recording));
}

/**
 * Recordings kept on this device that Eneo has not received yet; when the device cannot be read, a notice in
 * their place, so that the person is not left thinking there are none. "Fortsätt spela in" on a recording a reload cut
 * off is the page's one filled action, unless the person has chosen another way (`filled` false).
 */
export function UnsentRecordings({
  list: { recordings, unreadable, retry },
  onSend,
  onContinue,
  filled = true,
  withFlowName = false,
  sendLabel,
  evictable = false,
}: {
  list: UnsentList;
  onSend: (recording: StoredRecording) => void;
  onContinue?: (recording: StoredRecording) => void;
  /** False once the person has chosen another way on the page (a file): the page's own action is then the filled one. */
  filled?: boolean;
  withFlowName?: boolean;
  /** What a recording's send says: what its flow makes (lib/flow-output createActionLabel). */
  sendLabel: (recording: StoredRecording) => string;
  /** The browser may delete the recordings (useEvictable): the list then does not promise they stay. */
  evictable?: boolean;
}) {
  const headingId = useId();
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
  // A named region (Section is no landmark), as the screen reader's list of landmarks has it.
  return (
    <VStack role="region" aria-labelledby={headingId} gap={3}>
      <VStack gap={1}>
        <Heading level={2} id={headingId}>
          {cutOff
            ? "Inspelningen avbröts"
            : recordings.length === 1
              ? "En inspelning har inte skickats"
              : `${recordings.length} inspelningar har inte skickats`}
        </Heading>
        <Text as="p" color="secondary">
          {cutOff
            ? "Välj Fortsätt spela in så fortsätter den i samma inspelning."
            : recordings.length === 1
              ? evictable
                ? "Den finns på den här enheten, men webbläsaren kan rensa den om den ligger kvar osänd för länge."
                : "Den finns kvar på den här enheten tills den har skickats."
              : evictable
                ? "De finns på den här enheten, men webbläsaren kan rensa dem om de ligger kvar osända för länge."
                : "De finns kvar på den här enheten tills de har skickats."}
        </Text>
      </VStack>
      <List hasDividers>
        {recordings.map((recording) => (
          <UnsentRecordingRow
            key={recording.id}
            recording={recording}
            withFlowName={withFlowName}
            sendLabel={sendLabel(recording)}
            onSend={onSend}
            onContinue={continuable(recording) ? onContinue : undefined}
            primary={filled && recording === resumable}
          />
        ))}
      </List>
    </VStack>
  );
}

function UnsentRecordingRow({
  recording,
  withFlowName,
  sendLabel,
  onSend,
  onContinue,
  primary,
}: {
  recording: UnsentRecording;
  withFlowName: boolean;
  sendLabel: string;
  onSend: (recording: StoredRecording) => void;
  /** Given for a recording whose capture was cut off, where a recorder can take it over. */
  onContinue?: (recording: StoredRecording) => void;
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

  // Focus follows the question: to "Avbryt" when it opens, back to "Ta bort" when it closes.
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (wasConfirming.current) deleteRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  async function save() {
    setProblem(null);
    try {
      await saveRecordingAsFiles(recording.id);
    } catch {
      setProblem("Inspelningen kunde inte sparas som fil. Försök igen.");
    }
  }

  async function remove() {
    try {
      await (await recordingStore()).remove(recording.id);
    } catch (error) {
      setConfirming(false);
      setProblem(
        error instanceof Error && error.message === IN_USE_ELSEWHERE
          ? IN_USE_ELSEWHERE
          : "Inspelningen kunde inte tas bort. Försök igen.",
      );
    }
  }

  // The recording, then what can be done with it, both from the row's edge; deleting stands apart on a line of its own.
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
            </VStack>
          </HStack>
          {recording.exportOnly ? (
            // Without Web Locks another tab may still hold it: here it is only read.
            <VStack gap={2} hAlign="start">
              <Text as="p" color="secondary">
                I den här webbläsaren kan den bara sparas som fil.
              </Text>
              <Button label="Spara som fil" aria-describedby={summaryId} onClick={() => void save()} />
            </VStack>
          ) : confirming ? (
            <VStack role="group" aria-labelledby={questionId} gap={2} hAlign="start">
              <Text as="p" id={questionId}>
                Ta bort inspelningen från enheten? Det går inte att ångra.
              </Text>
              <HStack gap={3} wrap="wrap">
                <Button ref={cancelRef} label="Avbryt" onClick={() => setConfirming(false)} />
                <Button label="Ta bort" variant="destructive" onClick={() => void remove()} />
              </HStack>
            </VStack>
          ) : (
            <VStack gap={2} hAlign="start">
              <HStack gap={3} wrap="wrap">
                {onContinue && (
                  <Button
                    label="Fortsätt spela in"
                    variant={primary ? "primary" : "secondary"}
                    aria-describedby={summaryId}
                    onClick={() => onContinue(recording)}
                  />
                )}
                <Button label={sendLabel} aria-describedby={summaryId} onClick={() => onSend(recording)} />
                <Button label="Spara som fil" aria-describedby={summaryId} onClick={() => void save()} />
              </HStack>
              <Button
                ref={deleteRef}
                label="Ta bort"
                variant="ghost"
                icon={<Icon icon={Trash2} size="sm" />}
                aria-describedby={summaryId}
                onClick={() => setConfirming(true)}
              />
            </VStack>
          )}
          {problem && <Banner status="error" title={problem} collapsible={false} />}
        </VStack>
      }
    />
  );
}
