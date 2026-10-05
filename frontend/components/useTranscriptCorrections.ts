import { useEffect, useRef, useState } from "react";
import type { TranscriptContext } from "@/lib/transcript-context";
import type { CorrectionsSaveState } from "./TranscriptPlayer";
import { ApiError, saveTranscriptCorrections } from "@/lib/api";
import { downloadBlob } from "@/lib/download";
import { friendlyError } from "@/lib/errors";
import { EMPTY_CORRECTIONS, appendCorrectionSave, correctionRequest, correctionsFromResponse, correctionWriteProblem, sameCorrections, type CorrectionSet } from "@/lib/transcript-corrections";

const STALE_REVISION = "flow_transcript_corrections_stale_revision";

/** `reload` reads the transcript and its saved corrections again. */
export function useTranscriptCorrections(flowId: string, runId: string, transcript: TranscriptContext, reload: () => void) {
  const [corrections, setCorrections] = useState<CorrectionSet>(EMPTY_CORRECTIONS);
  const [saveState, setSaveState] = useState<CorrectionsSaveState>("idle");
  const [localError, setLocalError] = useState<string | null>(null);
  const revisionRef = useRef<number | null>(null);
  const saveQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  const generation = useRef(0);
  // What a refused, stale save says, kept through the reload that answers it.
  const staleNotice = useRef<string | null>(null);
  useEffect(() => {
    if (transcript.pending) return;
    setCorrections(transcript.corrections);
    revisionRef.current = transcript.corrections.revision;
    saveQueue.current = Promise.resolve(true);
    generation.current++;
    setSaveState("idle");
    setLocalError(staleNotice.current);
    staleNotice.current = null;
  }, [transcript.pending, transcript.corrections]);

  function onCorrectionsChange(next: CorrectionSet) {
    if (!transcript.stepId || transcript.correctionProblem) return;
    setCorrections(next);
    const requestGeneration = ++generation.current;
    setSaveState("saving");
    saveQueue.current = appendCorrectionSave(saveQueue.current, async () => {
      try {
        const saved = await saveTranscriptCorrections(flowId, runId, transcript.stepId!, correctionRequest(next, transcript.segments, revisionRef.current));
        const savedSet = correctionsFromResponse(saved, transcript.segments, next.segmentsHash);
        const problem = correctionWriteProblem(savedSet);
        if (problem) throw new Error(problem);
        revisionRef.current = saved.revision;
        setCorrections((prev) => sameCorrections(prev, next) ? { ...prev, revision: saved.revision, updatedAt: saved.updated_at } : prev);
        if (requestGeneration === generation.current) { setSaveState("saved"); setLocalError(null); }
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.code === STALE_REVISION) {
          // Someone else saved first: their corrections are read again and replace these, which could never be saved.
          staleNotice.current = friendlyError(err);
          reload();
          return false;
        }
        setSaveState("error");
        setLocalError(`${friendlyError(err)} Dina osparade rättningar finns kvar.`);
        return false;
      }
    }).then((saved) => { if (!saved) setSaveState("error"); return saved; });
  }
  async function retryCorrections() {
    await saveQueue.current;
    saveQueue.current = Promise.resolve(true);
    onCorrectionsChange(corrections);
  }
  function downloadUnsavedCorrections() {
    downloadBlob(
      new Blob([JSON.stringify({ flowId, runId, stepId: transcript.stepId, ...corrections, revision: revisionRef.current }, null, 2)], { type: "application/json" }),
      "osparade-rattningar.json",
    );
  }
  return { corrections, saveState, localError, saveQueue, onCorrectionsChange, retryCorrections, downloadUnsavedCorrections };
}
