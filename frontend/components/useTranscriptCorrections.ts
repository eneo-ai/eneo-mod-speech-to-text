import { useContext, useEffect, useRef, useState } from "react";
import type { TranscriptContext } from "@/lib/transcript-context";
import type { CorrectionsSaveState } from "./TranscriptPlayer";
import { AuthenticatedUserContext } from "./AuthGate";
import { ApiError, saveTranscriptCorrections } from "@/lib/api";
import { downloadBlob } from "@/lib/download";
import { browserDrafts, clearDraft, readDraft, writeDraft } from "@/lib/drafts";
import { friendlyError } from "@/lib/errors";
import { onlineStatus, type OnlineStatus } from "@/lib/online-status";
import { EMPTY_CORRECTIONS, appendCorrectionSave, correctionRequest, correctionsFromResponse, correctionWriteProblem, sameCorrections, withPrunedNames, type CorrectionSet, type SpeakerNames } from "@/lib/transcript-corrections";
import { LeaveContext } from "./flow/useLeaveQuestion";

const STALE_REVISION = "flow_transcript_corrections_stale_revision";
const READ_AGAIN = "Transkriberingen har lästs in igen, så ändringen sparades inte. Den senaste versionen visas nu. Gör om ändringen där.";

/** The corrections being saved, kept in the tab (lib/drafts) with the revision they were made on, until Eneo has them. */
type KeptCorrections = { revision: number | null; set: CorrectionSet };
const isKept = (value: unknown): value is KeptCorrections =>
  typeof value === "object" && value !== null && "set" in value && typeof (value as KeptCorrections).set === "object" && (value as KeptCorrections).set !== null;

/**
 * `reload` reads the transcript and its saved corrections again; the page asks for that through `readAgain`, which owns
 * what a read does to the corrections being saved.
 */
export function useTranscriptCorrections(flowId: string, runId: string, transcript: TranscriptContext, reload: () => void, online: OnlineStatus = onlineStatus) {
  const [corrections, setCorrections] = useState<CorrectionSet>(EMPTY_CORRECTIONS);
  const [saveState, setSaveState] = useState<CorrectionsSaveState>("idle");
  const [localError, setLocalError] = useState<string | null>(null);
  const revisionRef = useRef<number | null>(null);
  const saveQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  // Which read of the transcript the page's corrections are made on. A save belongs to the read it was made on: once the
  // page asks to read again, a save of an earlier read is not sent, and an answer to one writes nothing here.
  const read = useRef(0);
  // The corrections the page shows, as the last save in the queue sends them, ahead of the draw that shows them.
  const draft = useRef<CorrectionSet>(EMPTY_CORRECTIONS);
  const generation = useRef(0);
  // The corrections a read took from the screen before Eneo had them: the person's own. Kept for the person to take with
  // them (`downloadDropped`) until they have, or another save succeeds.
  const [dropped, setDropped] = useState<CorrectionSet | null>(null);
  // While a save has not gone through, the corrections are kept in the tab too: a page the browser discards or reloads
  // (a phone that put the tab away, a crash) has no leave question, and gives them back from there (below, once the
  // transcript, whose step names them, is read).
  const ownerId = useContext(AuthenticatedUserContext)?.id ?? null;
  const keptName = transcript.stepId ? `corrections:${runId}:${transcript.stepId}` : null;
  const keep = (set: CorrectionSet, revision: number | null) => {
    if (ownerId && keptName) writeDraft(browserDrafts(), ownerId, keptName, { revision, set } satisfies KeptCorrections);
  };
  // Whether the last save failed for want of a network (no answer at all): it is sent again when the connection is back.
  const noAnswer = useRef(false);

  // What is not saved is lost with the page: closing it asks first.
  const unsaved = saveState === "saving" || saveState === "error" || dropped !== null;
  const { holdUnsavedCorrections } = useContext(LeaveContext);
  useEffect(() => {
    if (unsaved) return holdUnsavedCorrections();
  }, [unsaved, holdUnsavedCorrections]);
  // Saved (or taken away by the person): nothing is kept in the tab any more.
  const wasUnsaved = useRef(false);
  useEffect(() => {
    if (unsaved) wasUnsaved.current = true;
    else if (wasUnsaved.current && ownerId && keptName) {
      wasUnsaved.current = false;
      clearDraft(browserDrafts(), ownerId, keptName);
    }
  }, [unsaved, ownerId, keptName]);
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
  // A read that lands is what Eneo has: the next save is made on it.
  useEffect(() => {
    if (transcript.pending) return;
    revisionRef.current = transcript.corrections.revision;
    draft.current = transcript.corrections;
  }, [transcript.pending, transcript.corrections]);
  // Whether corrections were made on the source of the transcript read, and whether they are what Eneo has on it.
  const sameSource = (set: CorrectionSet) => (set.segmentsHash ?? null) === (transcript.corrections.segmentsHash ?? null);
  const isSaved = (set: CorrectionSet) => sameSource(set) && sameCorrections(set, transcript.corrections);
  // Corrections a page before this one kept in the tab, once a read they can be saved on has landed (one that failed in
  // part leaves them kept until Läs in igen reads it whole): Eneo has them already (the answer was lost), or they were
  // made on what Eneo still has and are saved now. Made on another source of the transcript, or saved over since, they
  // are the person's to take, as after any refused save.
  const restored = useRef(false);
  const savable = !transcript.pending && transcript.stepId !== null && !transcript.correctionProblem;
  useEffect(() => {
    if (!savable || restored.current) return;
    restored.current = true;
    const kept = ownerId && keptName ? readDraft(browserDrafts(), ownerId, keptName, isKept) : null;
    if (!kept || !ownerId || !keptName) return;
    if (isSaved(kept.set)) {
      clearDraft(browserDrafts(), ownerId, keptName);
    } else if (sameSource(kept.set) && kept.revision === transcript.corrections.revision) {
      void save(kept.set, false);
    } else {
      setDropped(kept.set);
      setLocalError(sameSource(kept.set) ? friendlyError(new ApiError(409, "", null, STALE_REVISION)) : READ_AGAIN);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savable]);
  // Corrections a read took from the screen that are what Eneo has after all (a save whose answer was lost, sent again
  // and refused as stale): nothing was lost, and nothing is said to be.
  useEffect(() => {
    if (!dropped || transcript.pending || !isSaved(dropped)) return;
    setDropped(null);
    setLocalError(null);
    setSaveState("saved");
  }, [dropped, transcript.pending, transcript.corrections]);
  // A save that got no answer goes again by itself when the device, which lost its network, has it back: what a phone on
  // a meeting room's Wi-Fi does. A module that did not answer is left to Försök spara igen: with a network, sending
  // again by itself could repeat a request that keeps failing.
  const latestSaveNow = useRef<() => Promise<string | null>>(() => Promise.resolve(null));
  useEffect(() => {
    if (saveState !== "error" || !noAnswer.current) return;
    let wasOffline = online.connection === "offline";
    return online.subscribe((isOnline) => {
      if (!isOnline) wasOffline ||= online.connection === "offline";
      else if (wasOffline) void latestSaveNow.current();
    });
  }, [saveState, online]);

  /**
   * Reads the transcript again, and the page's corrections with it. The new read starts here, not when it lands: no save
   * made on the earlier one goes out from now, and an answer to one writes nothing on the page. `notice` is what the page
   * says when the read takes from the screen corrections Eneo did not get.
   */
  function readFrom(notice: string) {
    read.current++;
    const shown = draft.current;
    const madeBefore = generation.current;
    // The earlier read's saves end first, one request at a time. If the last of them did not go through (it failed, or
    // was not sent), Eneo does not have what the page showed, and the read takes it from the screen: kept for the person.
    // What comes after waits for no failure before it.
    saveQueue.current = appendCorrectionSave(saveQueue.current, async (previousSaved) => {
      if (!previousSaved) {
        setDropped(shown);
        setLocalError(notice);
      }
      // Nothing made on the new read yet: the page has nothing being saved.
      if (generation.current === madeBefore) setSaveState("idle");
      return true;
    }, true);
    reload();
  }
  /** Läs in igen: the transcript and its saved corrections, read again. */
  function readAgain() {
    readFrom(READ_AGAIN);
  }

  /**
   * Shows `next` and saves it after what is being saved, one request at a time; resolves with why it was not saved, or
   * null. A save waits behind one that failed; an `explicit` one goes after it all the same, and sends nothing for the
   * corrections shown once every save of them went through: Eneo has them. Read again before its turn, it is not sent.
   */
  function save(next: CorrectionSet, explicit: boolean): Promise<string | null> {
    if (!transcript.stepId || transcript.correctionProblem) return Promise.resolve(transcript.correctionProblem ?? "Transkriberingen kan inte ändras här.");
    // The page holds what it sends: a name for a speaker no passage or edit has any more goes here too.
    next = withPrunedNames(next, transcript.segments);
    // The corrections shown, saved again: nothing new to show, and they keep their generation, whichever of their saves lands.
    const again = explicit && sameCorrections(next, draft.current);
    if (again) next = draft.current;
    else {
      draft.current = next;
      setCorrections(next);
      generation.current++;
      setSaveState("saving");
      keep(next, revisionRef.current);
    }
    const requestGeneration = generation.current;
    const madeOn = read.current;
    // What a save that waits behind a failed one says, if it never runs.
    let refusal: string | null = "Den förra ändringen kunde inte sparas. Spara den igen först.";
    saveQueue.current = appendCorrectionSave(saveQueue.current, async (previousSaved) => {
      // The corrections shown, saved again, whose save before this went through: Eneo has them, read again since or not.
      if (again && previousSaved) {
        refusal = null;
        return true;
      }
      // Read again since: the page shows the read, and these corrections would replace it unseen.
      if (madeOn !== read.current) {
        refusal = READ_AGAIN;
        return false;
      }
      // Else they are sent again.
      if (again) setSaveState("saving");
      try {
        const saved = await saveTranscriptCorrections(flowId, runId, transcript.stepId!, correctionRequest(next, transcript.segments, revisionRef.current));
        const savedSet = correctionsFromResponse(saved, transcript.segments, next.segmentsHash);
        const problem = correctionWriteProblem(savedSet);
        if (problem) throw new Error(problem);
        refusal = null;
        // Read again while it was under way: Eneo has it, and the read is what the page shows. Had it landed after the
        // read, the next save meets a newer revision, and the page reads again.
        if (madeOn !== read.current) return true;
        revisionRef.current = saved.revision;
        // Unless a newer change is shown, the page has the corrections as Eneo saved them, its names too; names as they
        // were sent keep their object, so no passage is drawn again for them.
        const answered = { ...next, speakerNames: savedSet.speakerNames };
        const landed = { ...(sameCorrections(answered, next) ? next : answered), revision: saved.revision, updatedAt: saved.updated_at };
        if (draft.current === next) draft.current = landed;
        setCorrections((shown) => (shown === next ? landed : shown));
        if (requestGeneration === generation.current) { setSaveState("saved"); setLocalError(null); }
        // A newer change still to save is kept on the revision this one made.
        else keep(draft.current, saved.revision);
        setDropped(null);
        noAnswer.current = false;
        return true;
      } catch (err) {
        refusal = friendlyError(err);
        noAnswer.current = err instanceof TypeError;
        if (madeOn !== read.current) return false;
        if (err instanceof ApiError && err.code === STALE_REVISION) {
          // Someone else saved first: their corrections are read again and replace these, which could never be saved.
          readFrom(refusal);
          return false;
        }
        setLocalError(`${refusal} Dina osparade rättningar finns kvar.`);
        return false;
      }
    }, explicit).then((saved) => { if (!saved && madeOn === read.current) setSaveState("error"); return saved; });
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
  latestSaveNow.current = () => saveNow();
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
  return { corrections, saveState, localError, saveQueue, hasDropped: dropped !== null, onCorrectionsChange, saveNow, retryCorrections, downloadUnsavedCorrections, downloadDropped, readAgain };
}
