import { useContext, useEffect, useRef, useState } from "react";
import type { TranscriptContext } from "@/lib/transcript-context";
import type { CorrectionsSaveState } from "./TranscriptPlayer";
import { ApiError, saveTranscriptCorrections } from "@/lib/api";
import { downloadBlob } from "@/lib/download";
import { friendlyError } from "@/lib/errors";
import { EMPTY_CORRECTIONS, appendCorrectionSave, correctionRequest, correctionsFromResponse, correctionWriteProblem, sameCorrections, type CorrectionSet, type SpeakerNames } from "@/lib/transcript-corrections";
import { LeaveContext } from "./flow/useLeaveQuestion";

const STALE_REVISION = "flow_transcript_corrections_stale_revision";

/** `reload` reads the transcript and its saved corrections again. */
export function useTranscriptCorrections(flowId: string, runId: string, transcript: TranscriptContext, reload: () => void) {
  const [corrections, setCorrections] = useState<CorrectionSet>(EMPTY_CORRECTIONS);
  const [saveState, setSaveState] = useState<CorrectionsSaveState>("idle");
  const [localError, setLocalError] = useState<string | null>(null);
  const revisionRef = useRef<number | null>(null);
  const saveQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  // The corrections the page shows, as the last save in the queue sends them, ahead of the draw that shows them.
  const draft = useRef<CorrectionSet>(EMPTY_CORRECTIONS);
  const generation = useRef(0);
  // What a refused, stale save says, kept through the reload that answers it.
  const staleNotice = useRef<string | null>(null);
  // The corrections a stale save could not keep: the person's own, taken from the screen by the others' that are read
  // again. Kept for the person to take with them (`downloadDropped`) until they have, or another save succeeds.
  const [dropped, setDropped] = useState<CorrectionSet | null>(null);

  // What is not saved is lost with the page: closing it asks first.
  const unsaved = saveState === "saving" || saveState === "error" || dropped !== null;
  const { holdUnsavedCorrections } = useContext(LeaveContext);
  useEffect(() => {
    if (unsaved) return holdUnsavedCorrections();
  }, [unsaved, holdUnsavedCorrections]);
  useEffect(() => {
    if (!unsaved) return;
    const ask = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [unsaved]);
  // The corrections read with the transcript are the page's from the draw that has the transcript: taken in an effect,
  // that draw would show the transcript, and what the page says of its corrections, without them.
  const [taken, setTaken] = useState<CorrectionSet | null>(null);
  if (!transcript.pending && taken !== transcript.corrections) {
    setTaken(transcript.corrections);
    setCorrections(transcript.corrections);
  }
  useEffect(() => {
    if (transcript.pending) return;
    revisionRef.current = transcript.corrections.revision;
    draft.current = transcript.corrections;
    saveQueue.current = Promise.resolve(true);
    generation.current++;
    setSaveState("idle");
    setLocalError(staleNotice.current);
    staleNotice.current = null;
  }, [transcript.pending, transcript.corrections]);

  /**
   * Shows `next` and saves it after what is being saved, one request at a time; resolves with why it was not saved, or
   * null. A save waits behind one that failed; an `explicit` one goes after it all the same, and sends nothing for the
   * corrections shown once every save of them went through: Eneo has them.
   */
  function save(next: CorrectionSet, explicit: boolean): Promise<string | null> {
    if (!transcript.stepId || transcript.correctionProblem) return Promise.resolve(transcript.correctionProblem ?? "Transkriberingen kan inte ändras här.");
    // The corrections shown, saved again: nothing new to show, and they keep their generation, whichever of their saves lands.
    const again = explicit && sameCorrections(next, draft.current);
    if (again) next = draft.current;
    else {
      draft.current = next;
      setCorrections(next);
      generation.current++;
      setSaveState("saving");
    }
    const requestGeneration = generation.current;
    // What a save that waits behind a failed one says, if it never runs.
    let refusal: string | null = "Den förra ändringen kunde inte sparas. Spara den igen först.";
    saveQueue.current = appendCorrectionSave(saveQueue.current, async (previousSaved) => {
      if (again) {
        // Their save before this went through: Eneo has them. Else they are sent again.
        if (previousSaved) {
          refusal = null;
          return true;
        }
        setSaveState("saving");
      }
      try {
        const saved = await saveTranscriptCorrections(flowId, runId, transcript.stepId!, correctionRequest(next, transcript.segments, revisionRef.current));
        const savedSet = correctionsFromResponse(saved, transcript.segments, next.segmentsHash);
        const problem = correctionWriteProblem(savedSet);
        if (problem) throw new Error(problem);
        revisionRef.current = saved.revision;
        // Unless a newer change is shown, the page has the corrections as Eneo saved them.
        const landed = { ...next, revision: saved.revision, updatedAt: saved.updated_at };
        if (draft.current === next) draft.current = landed;
        setCorrections((shown) => (shown === next ? landed : shown));
        if (requestGeneration === generation.current) { setSaveState("saved"); setLocalError(null); }
        setDropped(null);
        refusal = null;
        return true;
      } catch (err) {
        refusal = friendlyError(err);
        if (err instanceof ApiError && err.code === STALE_REVISION) {
          // Someone else saved first: their corrections are read again and replace these, which could never be saved.
          staleNotice.current = refusal;
          setDropped(next);
          reload();
          return false;
        }
        setLocalError(`${refusal} Dina osparade rättningar finns kvar.`);
        return false;
      }
    }, explicit).then((saved) => { if (!saved) setSaveState("error"); return saved; });
    return saveQueue.current.then(() => refusal);
  }
  /** A correction made on the page: shown, and saved after what is being saved. */
  function onCorrectionsChange(next: CorrectionSet): Promise<string | null> {
    return save(next, false);
  }
  /**
   * A save the person asks for (Försök spara igen, Spara namnen): the corrections as the page shows them, with the `names`
   * given after the run when there are, saved after what is under way, also when an earlier save failed.
   */
  function saveNow(names?: SpeakerNames): Promise<string | null> {
    return save(names ? { ...draft.current, speakerNames: names } : draft.current, true);
  }
  async function retryCorrections() {
    await saveNow();
  }
  function downloadUnsavedCorrections() {
    saveCorrectionsFile(corrections, revisionRef.current);
  }
  function downloadDropped() {
    if (!dropped) return;
    saveCorrectionsFile(dropped, dropped.revision);
    setDropped(null);
  }
  function saveCorrectionsFile(set: CorrectionSet, revision: number | null) {
    downloadBlob(
      new Blob([JSON.stringify({ flowId, runId, stepId: transcript.stepId, ...set, revision }, null, 2)], { type: "application/json" }),
      "osparade-rattningar.json",
    );
  }
  return { corrections, saveState, localError, saveQueue, hasDropped: dropped !== null, onCorrectionsChange, saveNow, retryCorrections, downloadUnsavedCorrections, downloadDropped };
}
