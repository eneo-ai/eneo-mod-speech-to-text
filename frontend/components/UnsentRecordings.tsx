"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { saveRecordingAsFiles } from "@/components/save-recording";
import {
  IN_USE_ELSEWHERE,
  recordingStore,
  type StoredRecording,
} from "@/lib/recording-store";

/** The user's unsent recordings (of one flow, when given), kept current. */
export function useUnsentRecordings(ownerId: string, flowId?: string): StoredRecording[] {
  const [recordings, setRecordings] = useState<StoredRecording[]>([]);
  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};
    void recordingStore().then((store) => {
      if (cancelled) return;
      const load = () =>
        store.listUnsent(ownerId).then(
          (all) =>
            !cancelled && setRecordings(flowId ? all.filter((r) => r.flowId === flowId) : all),
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

function formatLength(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.round(ms / 1_000)} s`;
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function formatWhen(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  const days = Math.round(
    (new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (days === 0) return `i dag ${time}`;
  if (days === 1) return `i går ${time}`;
  return `${date.toLocaleDateString("sv-SE", { day: "numeric", month: "short" })} ${time}`;
}

/** "Osänd inspelning, Nämndmöte till rapport, 42 min, i dag 10:12" */
export function recordingSummary(
  recording: StoredRecording,
  { withFlowName = false, now = Date.now() }: { withFlowName?: boolean; now?: number } = {},
): string {
  return [
    "Osänd inspelning",
    ...(withFlowName ? [recording.flowName] : []),
    formatLength(recording.durationMs),
    formatWhen(recording.startedAt, now),
  ].join(", ");
}

/** Recordings kept on this device that Eneo has not received yet. */
export function UnsentRecordings({
  recordings,
  onSend,
  withFlowName = false,
}: {
  recordings: StoredRecording[];
  onSend: (recording: StoredRecording) => void;
  withFlowName?: boolean;
}) {
  const headingId = useId();
  if (recordings.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="paper-card p-4 mb-5">
      <h2 id={headingId} className="text-[13px] font-semibold text-ink mb-1">
        {recordings.length === 1
          ? "En inspelning är inte skickad"
          : `${recordings.length} inspelningar är inte skickade`}
      </h2>
      <p className="text-[12px] text-ink-soft mb-3">
        De finns kvar på den här enheten tills de har skickats.
      </p>
      <ul className="flex flex-col gap-2">
        {recordings.map((recording) => (
          <UnsentRecordingRow
            key={recording.id}
            recording={recording}
            withFlowName={withFlowName}
            onSend={onSend}
          />
        ))}
      </ul>
    </section>
  );
}

function UnsentRecordingRow({
  recording,
  withFlowName,
  onSend,
}: {
  recording: StoredRecording;
  withFlowName: boolean;
  onSend: (recording: StoredRecording) => void;
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
    <li className="rounded-lg border border-rule-soft bg-bg-2/40 px-3 py-2">
      <p id={summaryId} className="text-[13px] text-ink">
        {recordingSummary(recording, { withFlowName })}
      </p>
      {confirming ? (
        <div role="group" aria-labelledby={questionId} className="mt-2 flex flex-wrap items-center gap-2">
          <p id={questionId} className="basis-full text-[12px] text-ink-soft">
            Ta bort inspelningen från enheten? Det går inte att ångra.
          </p>
          <Button
            ref={cancelRef}
            type="button"
            variant="outline"
            className="h-11"
            onClick={() => setConfirming(false)}
          >
            Avbryt
          </Button>
          <Button type="button" className="h-11" onClick={() => void remove()}>
            Ta bort
          </Button>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            type="button"
            className="h-11"
            aria-describedby={summaryId}
            onClick={() => onSend(recording)}
          >
            Skicka
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11"
            aria-describedby={summaryId}
            onClick={() => void save()}
          >
            Spara som fil
          </Button>
          <Button
            ref={deleteRef}
            type="button"
            variant="ghost"
            className="h-11"
            aria-describedby={summaryId}
            onClick={() => setConfirming(true)}
          >
            Ta bort
          </Button>
        </div>
      )}
      {problem && (
        <p role="alert" className="mt-2 text-[12px] text-accent">
          {problem}
        </p>
      )}
    </li>
  );
}
