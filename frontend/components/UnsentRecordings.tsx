"use client";

import { Mic } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
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

/** The user's unsent recordings (of one flow, when given), kept current. */
export function useUnsentRecordings(ownerId: string, flowId?: string): UnsentRecording[] {
  const [recordings, setRecordings] = useState<UnsentRecording[]>([]);
  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};
    void recordingStore().then((store) => {
      if (cancelled) return;
      const load = () =>
        store.listUnsent(ownerId).then(
          (all) =>
            !cancelled &&
            setRecordings(
              (flowId ? all.filter((r) => r.flowId === flowId) : all).map((r) => ({
                ...r,
                exportOnly: !store.mayChange(r.id),
              })),
            ),
          () => undefined,
        );
      unsubscribe = store.subscribe(() => void load());
      void load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [ownerId, flowId]);
  return recordings;
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
 * Recordings kept on this device that Eneo has not received yet. Only "Fortsätt spela in" on a recording a
 * reload cut off is filled: the page has one filled action.
 */
export function UnsentRecordings({
  recordings,
  onSend,
  onContinue,
  withFlowName = false,
  sendLabel = () => "Skapa dokument",
}: {
  recordings: UnsentRecording[];
  onSend: (recording: StoredRecording) => void;
  onContinue?: (recording: StoredRecording) => void;
  withFlowName?: boolean;
  /** What a recording's send says: what its flow makes (lib/flow-session createActionLabel). */
  sendLabel?: (recording: StoredRecording) => string;
}) {
  const headingId = useId();
  if (recordings.length === 0) return null;
  const resumable = onContinue ? resumableRecording(recordings) : undefined;
  const cutOff = recordings.length === 1 && resumable !== undefined;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-[19px] font-semibold leading-snug tracking-[-0.01em] text-ink">
          {cutOff
            ? "Inspelningen avbröts"
            : recordings.length === 1
              ? "En inspelning är inte skickad"
              : `${recordings.length} inspelningar är inte skickade`}
        </h2>
        <p className="text-[15px] leading-relaxed text-ink-soft">
          {cutOff
            ? "Välj Fortsätt spela in så fortsätter den i samma inspelning."
            : recordings.length === 1
              ? "Den finns kvar på den här enheten tills den har skickats."
              : "De finns kvar på den här enheten tills de har skickats."}
        </p>
      </div>
      <ul className="flex flex-col gap-3">
        {recordings.map((recording) => (
          <UnsentRecordingRow
            key={recording.id}
            recording={recording}
            withFlowName={withFlowName}
            sendLabel={sendLabel(recording)}
            onSend={onSend}
            onContinue={continuable(recording) ? onContinue : undefined}
            primary={recording === resumable}
          />
        ))}
      </ul>
    </section>
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

  return (
    <li className="flex gap-4 rounded-xl border border-border bg-card p-4">
      <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
        <Mic className="size-5" strokeWidth={1.75} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <div id={summaryId} className="flex flex-col gap-0.5">
          <p className="text-[17px] font-semibold leading-snug text-ink">{recordingName(recording.startedAt)}</p>
          <p className="text-[15px] leading-snug text-ink-soft">{recordingDetails(recording, { withFlowName })}</p>
        </div>
        {recording.exportOnly ? (
          // Without Web Locks another tab may still hold it: here it is only read.
          <div className="mt-3 flex flex-col items-start gap-2">
            <p className="text-[15px] text-ink-soft">I den här webbläsaren kan den bara sparas som fil.</p>
            <Button type="button" variant="outline" aria-describedby={summaryId} onClick={() => void save()}>
              Spara som fil
            </Button>
          </div>
        ) : confirming ? (
          <div role="group" aria-labelledby={questionId} className="mt-3 flex flex-wrap items-center gap-2">
            <p id={questionId} className="basis-full text-[15px] text-ink">
              Ta bort inspelningen från enheten? Det går inte att ångra.
            </p>
            <Button
              ref={cancelRef}
              type="button"
              variant="outline"
              onClick={() => setConfirming(false)}
            >
              Avbryt
            </Button>
            <Button type="button" variant="destructive" onClick={() => void remove()}>
              Ta bort
            </Button>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {onContinue && (
              <Button
                type="button"
                variant={primary ? "default" : "outline"}
                aria-describedby={summaryId}
                onClick={() => onContinue(recording)}
              >
                Fortsätt spela in
              </Button>
            )}
            <Button type="button" variant="outline" aria-describedby={summaryId} onClick={() => onSend(recording)}>
              {sendLabel}
            </Button>
            <Button
              type="button"
              variant="outline"
              aria-describedby={summaryId}
              onClick={() => void save()}
            >
              Spara som fil
            </Button>
            <Button
              ref={deleteRef}
              type="button"
              variant="ghost"
              aria-describedby={summaryId}
              onClick={() => setConfirming(true)}
            >
              Ta bort
            </Button>
          </div>
        )}
        {problem && (
          <p role="alert" className="mt-2 text-[15px] text-destructive">
            {problem}
          </p>
        )}
      </div>
    </li>
  );
}
