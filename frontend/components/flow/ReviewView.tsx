"use client";

import { useTranscriptCorrections } from "@/components/useTranscriptCorrections";

import { CheckCircle2, Loader2, UsersRound } from "lucide-react";
import { SPEAKER_REVIEW_ENABLED } from "@/lib/speaker-review";
import {
  use,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { Button } from "@/components/ui/button";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAuthenticatedUser } from "@/components/AuthGate";
import { usePlayback } from "@/components/flow/AudioPlayer";
import { FlowTopBar } from "@/components/flow/FlowTopBar";
import { FRAME, ReadingMain } from "@/components/frame";
import { usePhaseHeading } from "@/components/flow/usePhaseHeading";
import { CopyButton } from "@/components/flow/CopyButton";
import { remarkResultHeadings } from "@/components/flow/ResultDocument";
import { holds } from "@/lib/review-continue";
import { useReviewDraft } from "@/components/useReviewDraft";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  inputFileAudioUrl,
  isReviewCheckpointApproved,
  type FlowPublished,
  type FlowRunPublic,
  type FlowRunReviewCheckpointPublic,
  type FlowRunStep,
  type Json,
  type ReviewEditedValue,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  buildEditedMapping,
  buildSpeakerRows,
  getSpeakerMappingInferNames,
  getSpeakerMappingParticipants,
  getSpeakerMappingSourceStep,
  isSpeakerMappingCheckpoint,
  namingRefusal,
  proposalNameToLabel,
  speakerNamesFromRows,
  unmappedSpeakerLabels,
  withSplitLabels,
  type SpeakerMappingRow,
} from "@/lib/speaker-mapping";
import { computeTurns, firstSegmentForSpeaker, speakerDisplayLabel, speakerSummaries } from "@/lib/transcript";
import { applyCorrections } from "@/lib/transcript-corrections";
import { SpeakerNamingDialog } from "@/components/SpeakerNamingDialog";
import { SpeakerMark, TranscriptPlayer } from "@/components/TranscriptPlayer";
import { useTranscriptContext } from "@/components/useTranscriptContext";
import { useConfirmedWords } from "@/components/useConfirmedWords";
import { confirmedWordsStorageKey } from "@/lib/confirmed-words";
import { formatDeadline } from "@/lib/format";


type ReviewEdit = { text?: string; speakerRows?: SpeakerMappingRow[] };

/** A review pause: the step's output (the speakers' names, or text) to look over, change and approve, or reject. */
export function ReviewView({
  flowId,
  published,
  checkpoint,
  runState,
  runError,
  onContinue,
  onSaveEdit,
  onReject,
}: {
  flowId: string;
  published: FlowPublished;
  checkpoint: FlowRunReviewCheckpointPublic;
  runState: { run: FlowRunPublic; steps: FlowRunStep[] };
  runError: string | null;
  /** Saves the edit (when the pause does not hold it yet), approves and resumes; returns why not, or null. */
  onContinue: (
    cp: FlowRunReviewCheckpointPublic,
    edit: ReviewEditedValue | null,
    options?: { describe?: (err: unknown) => string; onSaved?: () => void },
  ) => Promise<string | null>;
  onSaveEdit: (
    cp: FlowRunReviewCheckpointPublic,
    editedValue: ReviewEditedValue,
    describe?: (err: unknown) => string,
  ) => Promise<FlowRunReviewCheckpointPublic | { error: string }>;
  onReject: (cp: FlowRunReviewCheckpointPublic, reason: string) => Promise<void>;
}) {
  const payload = (checkpoint.current_payload_json as Json | null) ?? null;
  const isSpeakerMapping = isSpeakerMappingCheckpoint(payload);
  const title = isSpeakerMapping
    ? SPEAKER_REVIEW_ENABLED
      ? "Granska transkriptet"
      : "Vem är vem?"
    : (checkpoint.step_label ?? "Granska resultatet");
  const heading = usePhaseHeading(title);
  // Eneo ends an unanswered review at this time. Saying so does not meet WCAG 2.2.1 by itself: only a review window
  // longer than 20 hours does (Eneo's default is 14 days; a flow can set less).
  const deadline = checkpoint.expires_at ? (
    <> Granska senast {formatDeadline(checkpoint.expires_at)}. Därefter avbryts körningen.</>
  ) : null;
  const participants = getSpeakerMappingParticipants(payload);
  const inferNames = getSpeakerMappingInferNames(payload);
  const proposals = useMemo(() => buildSpeakerRows(payload), [payload]);
  // The mapping step's own proposal (name, confidence, evidence), before anyone edited it.
  const modelProposals = useMemo(
    () => buildSpeakerRows((checkpoint.original_payload_json as Json | null) ?? payload),
    [checkpoint.original_payload_json, payload],
  );

  // Unsaved edits outlast a reload (a lost login, a tab put to sleep) for this person; see useReviewDraft.
  const user = useAuthenticatedUser();
  const draftName = `review:${runState.run.id}:${checkpoint.id}`;
  const draft = useReviewDraft<ReviewEdit>(user.id, draftName, checkpoint.revision);

  const initialText = extractCheckpointText(payload);
  const [text, setText] = useState<string>(() => draft.initial?.text ?? initialText);
  const [speakerRows, setSpeakerRows] = useState<SpeakerMappingRow[]>(() => draft.initial?.speakerRows ?? proposals);
  const [editing, setEditing] = useState<boolean>(() => draft.initial?.text !== undefined);
  // What is being sent to Eneo; while anything is, nothing else starts and nothing can be edited.
  const [working, setWorking] = useState<"save" | "approve" | "reject" | null>(null);
  const inFlight = useRef(false);
  const saving = working === "save";
  const [showReject, setShowReject] = useState<boolean>(false);
  const [rejectReason, setRejectReason] = useState<string>("");
  const fieldId = useId();

  // A control that removes or disables itself hands the focus on once the view has changed, never to the page
  // (WCAG 2.4.3): Avvisa to the reason, its Avbryt back to Avvisa, Redigera to the text, and Spara ändring or the
  // edit's Avbryt back to Redigera.
  const handOff = useRef<RefObject<HTMLElement | null> | null>(null);
  const rejectButton = useRef<HTMLButtonElement>(null);
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const textField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const target = handOff.current?.current;
    // Not there yet, or still disabled while a request ends: a later render hands it on.
    if (!target || (target as HTMLButtonElement).disabled) return;
    handOff.current = null;
    target.focus();
  });

  // A kept edit the approved pause holds is saved, so it is no draft any more (and no reason to ask before leaving).
  useEffect(() => {
    if (!isReviewCheckpointApproved(checkpoint)) return;
    const held = (kept: ReviewEdit | null) =>
      kept !== null && holds(checkpoint, kept.speakerRows ? buildEditedMapping(kept.speakerRows) : (kept.text ?? ""));
    if (held(draft.initial)) draft.drop();
    if (held(draft.yours)) draft.dropYours();
  }, [checkpoint.revision, checkpoint.state]);

  // Synka när checkpoint uppdateras (t.ex. efter PATCH eller omhämtning).
  useEffect(() => {
    setText(draft.initial?.text ?? extractCheckpointText(payload));
    setSpeakerRows(draft.initial?.speakerRows ?? buildSpeakerRows(payload));
  }, [checkpoint.revision, checkpoint.current_payload_json]);

  function editText(next: string) {
    // Locked while a save, approval or resume is under way: its answer settles the draft of what was sent.
    if (busy) return;
    setText(next);
    if (next === initialText) draft.drop();
    else draft.keep({ text: next });
  }

  // "Använd din version" after the review changed: into the editor, as its current edit, for the user to save.
  function takeYours() {
    // Approved, the saved decision is final: no draft is put in its place. Nor while something is being sent.
    if (decided || busy) return;
    const yours = draft.takeYours();
    if (yours?.text !== undefined) {
      setText(yours.text);
      setEditing(true);
    }
    if (yours?.speakerRows) setSpeakerRows(yours.speakerRows);
  }

  // Transkriberingsstegets segment, ordtider, ljudfiler och sparade
  // korrigeringar för spelaren.
  const runId = runState.run.id;
  const reverseNames = useMemo(() => proposalNameToLabel(proposals), [proposals]);
  const [transcript] = useTranscriptContext({
    flowId,
    runId,
    enabled: isSpeakerMapping,
    source: getSpeakerMappingSourceStep(payload),
    fallbackText: initialText,
    labelFor: (speaker) => reverseNames[speaker] ?? speaker,
  });
  // Bekräftade osäkra ord lagras lokalt per steg (ryms inte i Eneos modell).
  const [confirmedWords, toggleConfirmed] = useConfirmedWords(
    transcript.stepId ? confirmedWordsStorageKey(flowId, runId, transcript.stepId) : null,
  );

  // One playback for the page: the transcript's player, and the speakers' samples in "Namnge talarna".
  const sources = useMemo(
    () => transcript.fileIds.map((id) => ({ url: inputFileAudioUrl(flowId, runId, id), durationMs: null })),
    [flowId, runId, transcript.fileIds],
  );
  const playback = usePlayback(sources);
  const sounds = useSyncExternalStore(
    playback.subscribe,
    () => playback.getSnapshot().playing || playback.getSnapshot().starting,
    () => false,
  );
  // The speaker whose sample was asked for; it plays while the playback does.
  const [sample, setSample] = useState<string | null>(null);
  const listening = sounds ? sample : null;

  const { corrections, saveState, localError, saveQueue, onCorrectionsChange, retryCorrections, downloadUnsavedCorrections } = useTranscriptCorrections(flowId, runId, transcript);

  // Fritextredigering är bara giltig för text-steg: Eneo kräver en sträng
  // som edited_value för `text` och ett JSON-värde för `json`. Speaker
  // mapping är json-steget vi redigerar strukturerat via talarrader.
  // Approved (and the resume still to go through): the saved decision is final, shown read-only, and the one
  // thing left is to go on.
  const decided = Boolean(isReviewCheckpointApproved(checkpoint));
  const editable =
    !decided &&
    checkpoint.review_mode === "edit" &&
    !isSpeakerMapping &&
    (checkpoint.output_type == null || checkpoint.output_type === "text");
  const textDirty = editing && text !== initialText;
  const speakersDirty =
    isSpeakerMapping &&
    JSON.stringify(buildEditedMapping(speakerRows)) !==
      JSON.stringify(buildEditedMapping(proposals));
  const dirty = isSpeakerMapping ? speakersDirty : textDirty;

  const speakerNames = useMemo(() => speakerNamesFromRows(speakerRows), [speakerRows]);
  const unmapped = isSpeakerMapping ? unmappedSpeakerLabels(speakerRows) : [];
  const hasAudio = transcript.fileIds.length > 0 && transcript.segments.length > 0;
  const speakerLabels = useMemo(() => speakerRows.map((r) => r.label), [speakerRows]);

  function pendingEditedValue(): ReviewEditedValue {
    return isSpeakerMapping ? buildEditedMapping(speakerRows) : text;
  }

  // A sample: the speaker's first passage, at most eight seconds, through the page's one player.
  function listenTo(label: string) {
    const target = firstSegmentForSpeaker(shownSegments, label);
    if (!target) return;
    const end = Math.min(shownSegments[target.segmentIndex].end, target.time + 8);
    setSample(label);
    playback.playRange(target.fileIndex, target.time * 1_000, end * 1_000);
  }

  // Stoppa exempel, or the dialog closed: a sample that plays stops; the transcript's own playback plays on.
  function stopListening() {
    if (listening) playback.pause();
    setSample(null);
  }

  // The speakers to name: the inventory, and any speaker split off in this review's corrections.
  const shownSegments = useMemo(() => applyCorrections(transcript.segments, corrections).segments, [transcript.segments, corrections]);
  const namingRows = useMemo(
    () => withSplitLabels(speakerRows, corrections.speaker_edits.map((edit) => edit.speaker)),
    [speakerRows, corrections.speaker_edits],
  );
  const passageCounts = useMemo(
    () => new Map(speakerSummaries(computeTurns(shownSegments)).map((s) => [s.label, s.passages])),
    [shownSegments],
  );

  /** The names on the page, and kept as a draft until Eneo has them; the draft's version, to drop once saved. */
  function keepNames(rows: SpeakerMappingRow[]): ReviewEdit {
    const named = rows.filter((row) => !row.split || row.name);
    setSpeakerRows(named);
    draft.keep({ speakerRows: named });
    return { speakerRows: named };
  }

  /**
   * One request to Eneo at a time: `work` runs only when nothing else is in flight, and only its own end makes the
   * review idle again. Otherwise it answers `refused`.
   */
  async function exclusively<T>(kind: "save" | "approve" | "reject", work: () => Promise<T>, refused: T): Promise<T> {
    if (inFlight.current) return refused;
    inFlight.current = true;
    setWorking(kind);
    try {
      return await work();
    } finally {
      inFlight.current = false;
      setWorking(null);
    }
  }
  const STILL_SENDING = "Något skickas redan till Eneo. Vänta tills det är klart och försök igen.";

  function saveNames(rows: SpeakerMappingRow[]): Promise<string | null> {
    return exclusively("save", async () => {
      const sent = keepNames(rows);
      const saved = await onSaveEdit(checkpoint, buildEditedMapping(rows), (err) => namingRefusal(err, rows));
      if ("error" in saved) return saved.error;
      draft.drop(sent);
      return null;
    }, STILL_SENDING);
  }

  /**
   * Godkänn / Spara och fortsätt, from the page or the naming dialog: the page's edit or the names, saved when the
   * pause does not hold them yet, then approved and resumed (onContinue). Returns why it did not go on, or null.
   */
  function saveAndApprove(names?: SpeakerMappingRow[]): Promise<string | null> {
    return exclusively("approve", async () => {
      // Pågående korrigeringssparningar måste landa före godkännandet, som
      // viker in dem i transkriptet. Misslyckades senaste sparningen: stanna.
      const correctionsSaved = await saveQueue.current;
      if (!correctionsSaved || (isSpeakerMapping && (transcript.pending || transcript.correctionProblem))) {
        return "Ändringarna i transkriptet är inte sparade än, så flödet kan inte fortsätta. Försök igen om en stund.";
      }
      // Approved already: nothing is saved any more, the run is only resumed.
      const edit = decided ? null : names ? buildEditedMapping(names) : dirty ? pendingEditedValue() : null;
      // The version sent, as its draft holds it: only that is dropped once Eneo has it.
      const sent: ReviewEdit = names && !decided ? keepNames(names) : isSpeakerMapping ? { speakerRows } : { text };
      return onContinue(checkpoint, edit, {
        describe: names ? (err) => namingRefusal(err, names) : undefined,
        // Saved now or held already, whether or not this view is shown again before the run goes on.
        onSaved: () => draft.drop(sent),
      });
    }, STILL_SENDING);
  }

  function saveOnly() {
    if (!dirty) return;
    const sent: ReviewEdit = { text };
    void exclusively("save", async () => {
      const saved = await onSaveEdit(checkpoint, pendingEditedValue());
      // Refused (a lost login, a newer revision): the edit stays open, and the text kept, for Spara ändring again.
      if ("error" in saved) return;
      handOff.current = editButton;
      setEditing(false);
      draft.drop(sent);
    }, undefined);
  }

  function submitReject() {
    // Approved, the pause is final: only resuming is left, never a rejection typed before it.
    if (decided || !rejectReason.trim()) return;
    void exclusively("reject", () => onReject(checkpoint, rejectReason.trim()).catch(() => undefined), undefined);
  }

  const busy = working !== null || saving;
  // The transcript's own changes must be saved before the flow goes on.
  const continueBlocked = isSpeakerMapping && (transcript.pending || Boolean(transcript.correctionProblem));
  // Approval folded the transcript's corrections in; a correction made after it would never reach the document.
  const canCorrect =
    isSpeakerMapping && transcript.fromMetadata && transcript.stepId !== null && !busy && !decided;

  const rejectSection = showReject && !decided ? (
    <section className={isSpeakerMapping ? undefined : "paper-card p-4 mb-5"}>
      <div id={`${fieldId}-avvisa`} className="text-[13px] font-semibold text-ink mb-1">Avvisa körningen</div>
      <p id={`${fieldId}-avvisa-hjalp`} className="text-[12px] text-ink-soft mb-3">
        Ange en kort motivering. Körningen kommer att avbrytas.
      </p>
      <textarea
        ref={reasonField}
        value={rejectReason}
        onChange={(e) => setRejectReason(e.target.value)}
        rows={3}
        placeholder="Skäl …"
        aria-labelledby={`${fieldId}-avvisa`}
        aria-describedby={`${fieldId}-avvisa-hjalp`}
        className={cn(REVIEW_FIELD, "text-[13px] coarse:text-base p-3 mb-3")}
      />
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            handOff.current = rejectButton;
            setShowReject(false);
            setRejectReason("");
          }}
          disabled={busy}
        >
          Avbryt
        </Button>
        <Button type="button" onClick={submitReject} disabled={!rejectReason.trim() || busy}>
          {working === "reject" ? <Loader2 data-icon="inline-start" aria-hidden className="animate-spin" /> : null}
          Bekräfta avvisning
        </Button>
      </div>
    </section>
  ) : null;

  const actions = (
    <div className={cn("flex flex-wrap items-center justify-between gap-3", !isSpeakerMapping && "mt-auto pt-4")}>
      {decided ? (
        <p className="text-[13px] text-ink-soft">
          {isSpeakerMapping ? "Namnen är redan sparade." : "Granskningen är redan godkänd."} Välj Fortsätt så går flödet vidare.
        </p>
      ) : (
        <Button
          ref={rejectButton}
          type="button"
          variant="ghost"
          onClick={() => {
            handOff.current = reasonField;
            setShowReject(true);
          }}
          disabled={busy || showReject}
        >
          Avvisa
        </Button>
      )}
      <Button type="button" onClick={() => void saveAndApprove()} disabled={busy || continueBlocked}>
        {working === "approve" ? (
          <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
        ) : (
          <CheckCircle2 aria-hidden className="h-4 w-4" strokeWidth={2} />
        )}
        {decided ? "Fortsätt" : dirty ? "Spara och fortsätt" : "Godkänn och fortsätt"}
      </Button>
    </div>
  );

  // Who is who: the decision, and what stops it, directly under Namnge talarna at every width, never after the
  // whole transcript.
  const decision = (
    <div className="mt-4 flex flex-col gap-4 border-t border-rule-soft pt-4">
      {(runError || localError) && (
        <p className="text-[13px] text-destructive" role="alert">
          {runError ?? localError}
        </p>
      )}
      {saveState === "error" && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={retryCorrections}>Försök spara igen</Button>
          <Button type="button" variant="outline" size="sm" onClick={downloadUnsavedCorrections}>Hämta osparade rättningar</Button>
        </div>
      )}
      {rejectSection}
      {actions}
    </div>
  );

  const header = <FlowTopBar title={published.name} titleIsHeading={false} />;
  const paused = <p className="mb-2 text-[13px] text-ink-mute">Pausat i steg {checkpoint.step_order}</p>;

  if (isSpeakerMapping) {
    return (
      <>
        {header}
        <main className={cn(FRAME, "flex flex-1 flex-col pb-6 pt-2 lg:pt-8")}>
          {paused}
          <h1 ref={heading} tabIndex={-1} className="text-[24px] md:text-[30px] font-semibold tracking-[-0.025em] leading-[1.15] mb-1 outline-none">
            {title}
          </h1>
          <p className="text-[13px] text-ink-soft leading-relaxed mb-5 max-w-prose">
            {SPEAKER_REVIEW_ENABLED ? "Lyssna, markera ord och välj vem som säger dem. Du kan också rätta texten." : "Lyssna och sätt namn på talarna. Namnen skrivs in i transkriptet när du fortsätter."}
            {deadline}
          </p>

          {/* One column that may shrink below its content: the speaker chips scroll instead of widening the page. */}
          <div className={SPEAKER_REVIEW_ENABLED ? "grid grid-cols-[minmax(0,1fr)] gap-3" : "grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] xl:grid-cols-[minmax(0,5fr)_minmax(0,8fr)] lg:items-start"}>
            <details open={SPEAKER_REVIEW_ENABLED ? undefined : true} className="paper-card p-4">
              <summary className={SPEAKER_REVIEW_ENABLED ? "cursor-pointer text-[13px] font-medium" : "hidden"}>
                Talare <span className="ml-2 font-normal text-ink-mute">{speakerRows.map((row) => row.name || speakerDisplayLabel(row.label)).join(", ")}</span>
              </summary>
              {SPEAKER_REVIEW_ENABLED && <p className="mt-3 mb-4 text-[12px] text-ink-mute">Namn gäller för talaren i hela transkriptet. För att byta vem som säger vissa ord, markera orden nedan.</p>}
              {speakerRows.length === 0 ? (
                <p className="text-[13px] text-ink-soft">
                  Inga talare kunde urskiljas i transkriptet. Du kan fortsätta
                  utan att namnge någon.
                </p>
              ) : (
                // Who is who at a glance; naming happens in "Namnge talarna".
                <div className="flex flex-col gap-3">
                  <ul className="flex flex-col">
                    {namingRows.map((row) => (
                        <li key={row.label} className="flex items-center gap-3 border-b border-rule-soft py-2.5 first:pt-0 last:border-0">
                          <SpeakerMark label={row.label} name={row.name ?? speakerDisplayLabel(row.label)} />
                          <span className="w-[4.5rem] shrink-0 text-[14px] font-medium text-ink">{speakerDisplayLabel(row.label)}</span>
                          <span className={row.name ? "min-w-0 truncate text-[15px] text-ink" : "text-[14px] text-ink-mute"}>
                            {row.name ?? "Inget namn"}
                          </span>
                        </li>
                    ))}
                  </ul>
                  <SpeakerNamingDialog
                    rows={namingRows}
                    proposals={modelProposals}
                    participants={participants}
                    passages={(label) => passageCounts.get(label) ?? namingRows.find((row) => row.label === label)?.lineCount ?? 0}
                    quote={(label) =>
                      shownSegments.find((segment) => segment.speaker === label)?.text ??
                      namingRows.find((row) => row.label === label)?.samples[0] ??
                      null
                    }
                    disabled={busy}
                    onListen={hasAudio ? listenTo : undefined}
                    listening={listening}
                    onStopListening={stopListening}
                    listenUnavailableReason={(label) => !firstSegmentForSpeaker(shownSegments, label) ? "Det finns inget tilldelat exempel utan överlappande tal." : null}
                    onSave={saveNames}
                    onSaveAndContinue={saveAndApprove}
                    continueDisabled={continueBlocked}
                    decided={decided}
                    draftKey={{ ownerId: user.id, name: `names:${draftName}` }}
                  >
                    <Button type="button" variant="outline" className="self-start" disabled={busy}>
                      <UsersRound data-icon="inline-start" aria-hidden />
                      Namnge talarna
                    </Button>
                  </SpeakerNamingDialog>
                </div>
              )}
              {unmapped.length > 0 && speakerRows.length > 0 && (
                <p className="mt-3 text-[12px] text-ink-mute leading-snug">
                  Talare utan namn behåller sin etikett i transkriptet.
                </p>
              )}
              {!SPEAKER_REVIEW_ENABLED && decision}
            </details>
            {/* There the card folds away, so the decision follows it instead. */}
            {SPEAKER_REVIEW_ENABLED && decision}

            {/* The card shows no title, but its parts ("Del 1") are h3s under this one. */}
            <h2 className="sr-only">Transkript</h2>
            <TranscriptPlayer
              className="paper-card lg:min-h-[28rem] lg:max-h-[calc(100vh-14rem)] lg:overflow-hidden"
              segments={transcript.segments}
              speakerReviews={transcript.speakerReviews}
              correctionProblem={transcript.correctionProblem}
              fileCount={transcript.fileIds.length}
              audioSrcFor={(fileIndex) =>
                inputFileAudioUrl(flowId, runId, transcript.fileIds[fileIndex] ?? "")
              }
              speakerNames={speakerNames}
              textFallback={initialText}
              audioPending={transcript.pending}
              playback={playback}
              corrections={corrections}
              editable={canCorrect}
              onCorrectionsChange={onCorrectionsChange}
              speakerOptions={speakerLabels}
              saveState={saveState}
              confirmedWords={confirmedWords}
              onToggleConfirmed={toggleConfirmed}
            />
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      {header}
      <ReadingMain>
        {paused}
        <h1 ref={heading} tabIndex={-1} className="text-[24px] md:text-[30px] font-semibold tracking-[-0.025em] leading-[1.15] mb-1 outline-none">
          {title}
        </h1>
        <p className="text-[13px] text-ink-soft leading-relaxed mb-5">
          {editable
            ? "Du kan ändra texten innan du godkänner och fortsätter."
            : "Granska innehållet och välj om flödet ska fortsätta."}
          {deadline}
        </p>

        <section className="paper-card p-4 mb-5">
          <div className="flex items-center justify-between mb-3">
            <div id={`${fieldId}-innehall`} className="text-[13px] font-semibold text-ink">Innehåll för granskning</div>
            <div className="text-[11px] text-ink-mute">
              {editable ? "Redigerbart" : "Skrivskyddat"}
            </div>
          </div>

          {editable && editing ? (
            <textarea
              ref={textField}
              value={text}
              readOnly={busy}
              onChange={(e) => editText(e.target.value)}
              rows={Math.min(24, Math.max(8, text.split("\n").length + 1))}
              aria-labelledby={`${fieldId}-innehall`}
              className={cn(REVIEW_FIELD, "text-[14px] md:text-[15px] coarse:text-base leading-relaxed p-3 md:p-4 font-sans")}
            />
          ) : (
            <article className="prose prose-sm md:prose-base max-w-none text-[14px] md:text-[15px] leading-relaxed">
              {/* Approved, the decision is what the pause holds, whatever the page had in hand. */}
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkResultHeadings]}>{decided ? initialText : text}</ReactMarkdown>
            </article>
          )}

          {editable && (
            <div className="flex items-center justify-end gap-2 mt-3">
              {editing ? (
                <>
                  <button
                    key="avbryt"
                    type="button"
                    onClick={() => {
                      handOff.current = editButton;
                      setText(initialText);
                      setEditing(false);
                      draft.drop();
                    }}
                    disabled={busy}
                    className="text-[12px] text-ink-soft hover:text-ink px-3 py-1.5 transition-colors disabled:opacity-50 coarse:min-h-11"
                  >
                    Avbryt
                  </button>
                  <button
                    type="button"
                    onClick={saveOnly}
                    disabled={!dirty || busy}
                    className="inline-flex items-center gap-1.5 rounded-full bg-paper border border-rule-soft text-ink px-3.5 py-1.5 text-[12px] font-medium disabled:opacity-50 coarse:min-h-11"
                  >
                    {saving ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : null}
                    Spara ändring
                  </button>
                </>
              ) : (
                <button
                  key="redigera"
                  ref={editButton}
                  type="button"
                  onClick={() => {
                    handOff.current = textField;
                    setEditing(true);
                  }}
                  disabled={busy}
                  className="text-[12px] text-ink-soft hover:text-ink px-3 py-1.5 transition-colors coarse:min-h-11"
                >
                  Redigera
                </button>
              )}
            </div>
          )}
        </section>

        {draft.yours && decided && (
          // Kept to copy, never to continue with: the approved text above is the decision.
          <Alert className="mb-3">
            <AlertTitle>Din ändring sparades inte</AlertTitle>
            <AlertDescription>
              <p>Granskningen godkändes med texten ovan. Din version visas här om du vill kopiera den.</p>
              {draft.yours.text !== undefined && (
                <p className="mt-2 whitespace-pre-wrap rounded-md bg-muted p-3 text-ink">{draft.yours.text}</p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                {draft.yours.text !== undefined && <CopyButton text={draft.yours.text} label="Kopiera din version" size="sm" />}
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => draft.dropYours()}>
                  Ta bort din version
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
        {draft.yours && !decided && (
          <Alert className="mb-3">
            <AlertTitle>Din ändring sparades inte</AlertTitle>
            <AlertDescription>
              <p>Granskningen har ändrats sedan du började. Här visas den senaste versionen, och din version finns kvar.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" size="sm" disabled={busy} onClick={takeYours}>
                  Använd din version
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => draft.dropYours()}>
                  Behåll den senaste
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
        {runError && (
          <p className="text-[13px] text-destructive mb-3" role="alert">
            {runError}
          </p>
        )}
        {rejectSection}
        {actions}
      </ReadingMain>
    </>
  );
}

// A review's text field: an edge that identifies it (3:1) and a ring on keyboard focus.
const REVIEW_FIELD =
  "w-full rounded-lg border border-input bg-bg-2/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function extractCheckpointText(payload: Json | null | undefined): string {
  if (!payload) return "";
  const text = (payload as { text?: unknown }).text;
  if (typeof text === "string") return text;
  // Fallback: visa payloaden som JSON så användaren ändå kan granska.
  try {
    return "```json\n" + JSON.stringify(payload, null, 2) + "\n```";
  } catch {
    return "";
  }
}
