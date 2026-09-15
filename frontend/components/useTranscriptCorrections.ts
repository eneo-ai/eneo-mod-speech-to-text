"use client";
import { useEffect, useRef, useState } from "react";
import type { TranscriptContext } from "./useTranscriptContext";
import type { CorrectionsSaveState } from "./TranscriptPlayer";
import { saveTranscriptCorrections } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { EMPTY_CORRECTIONS, appendCorrectionSave, correctionRequest, correctionsFromResponse, correctionWriteProblem, sameCorrections, type CorrectionSet } from "@/lib/transcript-corrections";

export function useTranscriptCorrections(flowId: string, runId: string, transcript: TranscriptContext) {
  const [corrections, setCorrections] = useState<CorrectionSet>(EMPTY_CORRECTIONS);
  const [saveState, setSaveState] = useState<CorrectionsSaveState>("idle");
  const [localError, setLocalError] = useState<string | null>(null);
  const revisionRef = useRef<number | null>(null);
  const saveQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  const generation = useRef(0);
  useEffect(() => {
    if (transcript.pending) return;
    setCorrections(transcript.corrections);
    revisionRef.current = transcript.corrections.revision;
    saveQueue.current = Promise.resolve(true);
    generation.current++;
    setSaveState("idle"); setLocalError(null);
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
        setSaveState("error");
        setLocalError(`${friendlyError(err)} Dina osparade rättningar finns kvar. Vid versionskonflikt behöver ändringarna jämföras med det aktuella underlaget innan de kan sparas.`);
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
    const url = URL.createObjectURL(new Blob([JSON.stringify({ flowId, runId, stepId: transcript.stepId, ...corrections, revision: revisionRef.current }, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "osparade-rattningar.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return { corrections, saveState, localError, saveQueue, onCorrectionsChange, retryCorrections, downloadUnsavedCorrections };
}
