import { useTranscriptCorrections } from "@/components/useTranscriptCorrections";

import { CheckCircle2, Pencil, UsersRound } from "lucide-react";
import { SPEAKER_REVIEW_ENABLED } from "@/lib/speaker-review";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Heading } from "@astryxdesign/core/Heading";
import { useAnnounce } from "@astryxdesign/core/hooks";
import { HStack } from "@astryxdesign/core/HStack";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { VStack } from "@astryxdesign/core/VStack";
import { ActionRow } from "@/components/ActionRow";
import { useAuthenticatedUser } from "@/components/AuthGate";
import { usePlayback } from "@/components/flow/AudioPlayer";
import { usePhaseHeading } from "@/components/flow/usePhaseHeading";
import { CopyButton } from "@/components/flow/CopyButton";
import { Markdown } from "@/components/flow/Markdown";
import { holds } from "@/lib/review-continue";
import { useReviewDraft } from "@/components/useReviewDraft";
import {
  inputFileAudioUrl,
  isReviewCheckpointApproved,
  type FlowRunPublic,
  type FlowRunReviewCheckpointPublic,
  type FlowRunStep,
  type Json,
  type ReviewEditedValue,
} from "@/lib/api";
import { savedSets, type SavedCorrections } from "@/lib/follow-run";
import {
  buildEditedMapping,
  buildSpeakerRows,
  getSpeakerMappingParticipants,
  getSpeakerMappingSourceStep,
  isSpeakerMappingCheckpoint,
  isUnsureProposal,
  namingRefusal,
  proposalNameToLabel,
  speakerNamesFromRows,
  unmappedSpeakerLabels,
  withSplitLabels,
  type SpeakerMappingRow,
} from "@/lib/speaker-mapping";
import { computeTurns, firstSegmentForSpeaker, speakerDisplayLabel, speakerSummaries } from "@/lib/transcript";
import { applyCorrections } from "@/lib/transcript-corrections";
import { hasNamesDraft, SpeakerNamingDialog, type SpeakerNamingHandle } from "@/components/SpeakerNamingDialog";
import { SpeakerMark } from "@/components/SpeakerMark";
import { TranscriptPlayer } from "@/components/TranscriptPlayer";
import { useTranscriptContext } from "@/components/useTranscriptContext";
import { useConfirmedWords } from "@/components/useConfirmedWords";
import { confirmedWordsStorageKey } from "@/lib/confirmed-words";
import { isRecord } from "@/lib/is-record";
import { formatDeadline } from "@/lib/format";
import { useDock } from "@/lib/dock";
import styles from "./ReviewView.module.css";

type ReviewEdit = { text?: string; speakerRows?: SpeakerMappingRow[] };

/** A speaker row as the review keeps it in an edit: every part the page then shows or sends. */
const isSpeakerRow = (value: unknown): value is SpeakerMappingRow =>
  isRecord(value) &&
  typeof value.label === "string" &&
  typeof value.lineCount === "number" &&
  Array.isArray(value.samples) && value.samples.every((sample) => typeof sample === "string") &&
  (typeof value.name === "string" || value.name === null) &&
  (value.confidence === "low" || value.confidence === "medium" || value.confidence === "high") &&
  typeof value.evidence === "string" &&
  (value.split === undefined || typeof value.split === "boolean");

/** What a kept edit is read as: the text or the speakers' rows, as the page keeps them, each of its own type. */
const isReviewEdit = (value: unknown): value is ReviewEdit =>
  isRecord(value) &&
  (value.text !== undefined || value.speakerRows !== undefined) &&
  (value.text === undefined || typeof value.text === "string") &&
  (value.speakerRows === undefined || (Array.isArray(value.speakerRows) && value.speakerRows.every(isSpeakerRow)));

const STILL_SENDING = "Något skickas redan till Eneo. Vänta tills det är klart och försök igen.";

/** A review pause: the step's output (the speakers' names, or text) to look over, change and approve, or reject. */
export function ReviewView({
  flowId,
  flowName,
  checkpoint,
  runState,
  savedCorrections,
  runError,
  onContinue,
  onSaveEdit,
  onReject,
}: {
  flowId: string;
  flowName: string;
  checkpoint: FlowRunReviewCheckpointPublic;
  runState: { run: FlowRunPublic; steps: FlowRunStep[] };
  /** The transcript's saved corrections, as read with the pause (readActivePause, SavedCorrections). */
  savedCorrections?: SavedCorrections;
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
      ? "Granska transkriberingen"
      : "Vem är vem?"
    : (checkpoint.step_label ?? "Granska resultatet");
  const heading = usePhaseHeading(title);
  const announce = useAnnounce();
  // Eneo ends an unanswered review at this time. Saying so does not meet WCAG 2.2.1 by itself: only a review window
  // longer than 20 hours does (Eneo's default is 14 days; a flow can set less).
  // A consequence, at the body's size: not a footnote.
  const deadline = checkpoint.expires_at ? (
    <Text as="p" color="secondary">
      Granska senast {formatDeadline(checkpoint.expires_at)}. Därefter avbryts körningen.
    </Text>
  ) : null;
  const participants = getSpeakerMappingParticipants(payload);
  const proposals = useMemo(() => buildSpeakerRows(payload), [payload]);
  // The mapping step's own proposal (name, confidence, evidence), before anyone edited it.
  const modelProposals = useMemo(
    () => buildSpeakerRows((checkpoint.original_payload_json as Json | null) ?? payload),
    [checkpoint.original_payload_json, payload],
  );

  // Unsaved edits outlast a reload (a lost login, a tab put to sleep) for this person; see useReviewDraft.
  const user = useAuthenticatedUser();
  const draftName = `review:${runState.run.id}:${checkpoint.id}`;
  const draft = useReviewDraft(user.id, draftName, checkpoint.revision, isReviewEdit);
  const namesDraftKey = { ownerId: user.id, name: `names:${draftName}` };

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
  // The naming dialog, opened at one speaker by Byt namn på in a passage's Ändra talare.
  const namingDialog = useRef<SpeakerNamingHandle>(null);

  // A control that removes or disables itself hands the focus on once the view has changed, never to the page
  // (WCAG 2.4.3): Avvisa to the reason, its Avbryt back to Avvisa, Redigera to the text, and Spara ändring or the
  // edit's Avbryt back to Redigera.
  const handOff = useRef<RefObject<HTMLElement | null> | null>(null);
  const rejectButton = useRef<HTMLButtonElement>(null);
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const textField = useRef<HTMLTextAreaElement>(null);
  // Swapping the text for its editor (and back) changes the page's height for a moment, and the browser would pull a
  // reader halfway through a long text back to its top: the place they read at is kept, before the swap is painted.
  const readAt = useRef<number | null>(null);
  // Read while rendering, before the swap is committed.
  readAt.current = typeof window === "undefined" ? null : window.scrollY;
  useLayoutEffect(() => {
    const at = readAt.current;
    if (at !== null && window.scrollY !== at) window.scrollTo({ top: at, behavior: "instant" });
  }, [editing]);

  useEffect(() => {
    const target = handOff.current?.current;
    // Not there yet, or still disabled while a request ends: a later render hands it on.
    if (!target || (target as HTMLButtonElement).disabled) return;
    handOff.current = null;
    if (target !== textField.current) {
      target.focus();
      return;
    }
    // The text opens where it is read, never scrolled away from it; one the window shows whole opens for more at its
    // end, where a reviewer adds (Safari and Firefox put the caret at the start).
    const field = textField.current;
    field.focus({ preventScroll: true });
    const { top, bottom } = field.getBoundingClientRect();
    if (top >= 0 && bottom <= window.innerHeight) field.setSelectionRange(field.value.length, field.value.length);
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
  const source = getSpeakerMappingSourceStep(payload);
  const [transcript, reloadTranscript] = useTranscriptContext({
    flowId,
    runId,
    enabled: isSpeakerMapping,
    source,
    fallbackText: initialText,
    labelFor: (speaker) => reverseNames[speaker] ?? speaker,
    savedCorrections,
  });
  // Bekräftade osäkra ord lagras lokalt per steg (ryms inte i Eneos modell).
  const [confirmedWords, toggleConfirmed] = useConfirmedWords(
    transcript.stepId ? confirmedWordsStorageKey(user.id, flowId, runId, transcript.stepId) : null,
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

  const { corrections, saveState, localError, hasDropped, saveQueue, onCorrectionsChange, retryCorrections, downloadUnsavedCorrections, downloadDropped } = useTranscriptCorrections(flowId, runId, transcript, reloadTranscript);
  // The text review's decision, docked at the window's bottom: focus scrolls stop above it (lib/dock.ts).
  const [, decisionDock] = useDock();

  // Fritextredigering är bara giltig för text-steg: Eneo kräver en sträng
  // som edited_value för `text` och ett JSON-värde för `json`. Speaker
  // mapping är json-steget vi redigerar strukturerat via talarrader.
  // Approved (and the resume still to go through): the saved decision is final, shown read-only, and the one
  // thing left is to go on.
  const decided = isReviewCheckpointApproved(checkpoint);
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

  // The speakers to name: the inventory, and any speaker split off in this review's corrections. While the transcript
  // is read, the corrections as read with the pause say who those are, so the list has its rows from the first draw and
  // the actions under it stay where they are; a set Eneo marks stale is not the transcript's and reserves no row.
  const shownSegments = useMemo(() => applyCorrections(transcript.segments, corrections).segments, [transcript.segments, corrections]);
  const splitSpeakers = useMemo(
    () =>
      (transcript.pending
        ? (savedSets(savedCorrections)?.find((set) => set.step_id === source.stepId && !set.stale)?.speaker_edits ?? [])
        : corrections.speaker_edits
      ).map((edit) => edit.speaker),
    [transcript.pending, savedCorrections, source.stepId, corrections.speaker_edits],
  );
  const namingRows = useMemo(() => withSplitLabels(speakerRows, splitSpeakers), [speakerRows, splitSpeakers]);
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
  function saveNames(rows: SpeakerMappingRow[]): Promise<string | null> {
    // The speakers that saved corrections add are only a place in the list until the transcript has read and checked
    // those corrections: no name is saved for one before then.
    if (transcript.pending) return Promise.resolve("Transkriberingen läses fortfarande in. Försök igen om en stund.");
    return exclusively("save", async () => {
      const sent = keepNames(rows);
      const saved = await onSaveEdit(checkpoint, buildEditedMapping(rows), (err) => namingRefusal(err, rows));
      if ("error" in saved) return saved.error;
      draft.drop(sent);
      // The dialog closes and the list shows the names; a screen reader hears it too.
      announce("Namnen är sparade.");
      return null;
    }, STILL_SENDING);
  }

  /**
   * Godkänn och fortsätt / Spara och fortsätt / Fortsätt: the page's edit, saved when the pause does not hold it yet,
   * then approved and resumed (onContinue). Returns why it did not go on, or null.
   */
  function saveAndApprove(): Promise<string | null> {
    return exclusively("approve", async () => {
      // Pågående korrigeringssparningar måste landa före godkännandet, som
      // viker in dem i transkriberingen. Misslyckades senaste sparningen: stanna.
      const correctionsSaved = await saveQueue.current;
      if (!correctionsSaved || (isSpeakerMapping && (transcript.pending || transcript.correctionProblem))) {
        return "Ändringarna i transkriberingen är inte sparade än, så flödet kan inte fortsätta. Försök igen om en stund.";
      }
      // Approved already: nothing is saved any more, the run is only resumed.
      const edit = decided ? null : dirty ? pendingEditedValue() : null;
      // The version sent, as its draft holds it: only that is dropped once Eneo has it.
      const sent: ReviewEdit = isSpeakerMapping ? { speakerRows } : { text };
      return onContinue(checkpoint, edit, {
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
      // The editor closing shows it; a screen reader hears it.
      announce("Ändringen är sparad.");
    }, undefined);
  }

  function submitReject() {
    // Approved, the pause is final: only resuming is left, never a rejection typed before it.
    if (decided || !rejectReason.trim()) return;
    void exclusively("reject", () => onReject(checkpoint, rejectReason.trim()), undefined);
  }

  const busy = working !== null;
  // The transcript's own changes must be saved before the flow goes on.
  const continueBlocked = isSpeakerMapping && (transcript.pending || Boolean(transcript.correctionProblem) || saveState === "error" || hasDropped);
  // Approval folded the transcript's corrections in; a correction made after it would never reach the document.
  const canCorrect =
    isSpeakerMapping && transcript.fromMetadata && transcript.stepId !== null && !busy && !decided;

  // While the reason form is open it is the decision, with its own Avbryt and Bekräfta avvisning: Avvisa and Godkänn
  // are not shown beside it.
  const rejecting = showReject && !decided;
  const rejectSection = rejecting ? (
    <VStack as="section" gap={3} className={isSpeakerMapping ? undefined : styles.card}>
      <TextArea
        ref={reasonField}
        label="Avvisa körningen"
        description="Körningen avbryts och flödet går inte vidare. Ange en kort motivering."
        placeholder="Skäl…"
        rows={3}
        value={rejectReason}
        onChange={setRejectReason}
      />
      <ActionRow>
        <Button
          variant="ghost"
          label="Avbryt"
          isDisabled={busy}
          onClick={() => {
            handOff.current = rejectButton;
            setShowReject(false);
            setRejectReason("");
          }}
        />
        <Button variant="destructive" label="Bekräfta avvisning" isLoading={working === "reject"} isDisabled={!rejectReason.trim() || busy} onClick={submitReject} />
      </ActionRow>
    </VStack>
  ) : null;

  // The choice as a pair of one height: Avvisa, then the action the page exists for (ActionRow places them).
  const actions = rejecting ? null : (
    <VStack gap={3}>
      {decided && (
        <Text as="p" type="supporting">
          {isSpeakerMapping ? "Namnen är redan sparade." : "Granskningen är redan godkänd."} Välj Fortsätt så går flödet vidare.
        </Text>
      )}
      <ActionRow>
        {!decided && (
          <Button
            ref={rejectButton}
            variant="secondary"
            label="Avvisa körningen"
            isDisabled={busy}
            onClick={() => {
              handOff.current = reasonField;
              setShowReject(true);
            }}
          />
        )}
        <Button
          variant="primary"
          icon={<CheckCircle2 aria-hidden />}
          label={decided ? "Fortsätt" : dirty ? "Spara och fortsätt" : "Godkänn och fortsätt"}
          isLoading={working === "approve"}
          isDisabled={busy || continueBlocked}
          onClick={() => void saveAndApprove()}
        />
      </ActionRow>
    </VStack>
  );

  // Who is who: the decision, and what stops it, under the speakers' card at every width, never after the whole
  // transcript.
  const decision = (
    <VStack gap={4}>
      {(runError || localError) && <Banner status="error" title={(runError ?? localError)!} collapsible={false} />}
      {hasDropped && <Button variant="secondary" size="sm" label="Hämta dina rättningar" onClick={downloadDropped} />}
      {saveState === "error" && (
        <HStack gap={2} wrap="wrap">
          <Button variant="secondary" size="sm" label="Försök spara igen" onClick={retryCorrections} />
          <Button variant="secondary" size="sm" label="Hämta osparade rättningar" onClick={downloadUnsavedCorrections} />
        </HStack>
      )}
      {rejectSection}
      {actions}
    </VStack>
  );

  // The flow's name stands here at every width, as on the result's line: the top bar holds no name.
  const paused = (
    <Text as="p" type="supporting">
      {flowName} · Väntar på din granskning
    </Text>
  );

  if (isSpeakerMapping) {
    // Who is who at a glance; naming happens in "Namnge talarna", the card's own action at the end of its heading's row.
    // A name the flow guessed and was not sure of says so here too, not only in the dialog.
    const speakerList =
      speakerRows.length === 0 ? (
        <Text as="p" type="supporting">
          Inga talare kunde urskiljas i transkriberingen. Du kan fortsätta utan att namnge någon.
        </Text>
      ) : (
        // Who someone is leads; the label the transcription gave them, or that they have no name yet, supports it.
        <List aria-label="Talare" density="compact" hasDividers>
          {namingRows.map((row) => (
            <ListItem
              key={row.label}
              label={row.name ?? speakerDisplayLabel(row.label)}
              startContent={<SpeakerMark label={row.label} name={row.name ?? speakerDisplayLabel(row.label)} />}
              description={
                !row.name
                  ? "Inget namn"
                  : isUnsureProposal(row, modelProposals)
                    ? `${speakerDisplayLabel(row.label)} · Osäkert förslag`
                    : speakerDisplayLabel(row.label)
              }
            />
          ))}
        </List>
      );
    const namingAction =
      speakerRows.length === 0 ? null : (
          <SpeakerNamingDialog
            ref={namingDialog}
            rows={namingRows}
            proposals={modelProposals}
            participants={participants}
            passages={(label) => passageCounts.get(label) ?? namingRows.find((row) => row.label === label)?.lineCount ?? 0}
            quote={(label) =>
              shownSegments.find((segment) => segment.speaker === label)?.text ??
              namingRows.find((row) => row.label === label)?.samples[0] ??
              null
            }
            disabled={busy || transcript.pending}
            onListen={hasAudio ? listenTo : undefined}
            listening={listening}
            onStopListening={stopListening}
            listenUnavailableReason={(label) => !firstSegmentForSpeaker(shownSegments, label) ? "Det finns inget tilldelat exempel utan överlappande tal." : null}
            onSave={saveNames}
            decided={decided}
            draftKey={namesDraftKey}
          >
            <Button
              variant="secondary"
              icon={<UsersRound aria-hidden />}
              label="Namnge talarna"
              isDisabled={busy || transcript.pending}
            />
          </SpeakerNamingDialog>
      );
    const speakers = (
      <VStack gap={4}>
        {speakerList}
        {namingAction}
      </VStack>
    );
    const unmappedNote = unmapped.length > 0 && speakerRows.length > 0 && (
      <Text as="p" type="supporting">
        Talare utan namn behåller sin etikett i transkriberingen.
      </Text>
    );

    const intro = (
      <VStack gap={1}>
        {paused}
        <Heading level={1} ref={heading} tabIndex={-1}>
          {title}
        </Heading>
        <Text as="p" color="secondary" className={styles.description}>
          {SPEAKER_REVIEW_ENABLED ? "Lyssna, markera ord och välj vem som säger dem. Du kan också rätta texten." : "Lyssna och sätt namn på talarna. Namnen skrivs in i transkriberingen när du fortsätter."}
        </Text>
        {deadline}
      </VStack>
    );

    return (
      <VStack gap={6}>
        {SPEAKER_REVIEW_ENABLED && intro}

        {/* One column that may shrink below its content: the speaker chips scroll instead of widening the page. Split
            from a laptop's width, the heading stands over the speakers, so the transcript beside them starts at the
            page's top and ends in the window; a workspace, whose column grows with a wide window (styles/globals.css). */}
        <div className={SPEAKER_REVIEW_ENABLED ? styles.review : styles.reviewSplit} data-workspace={SPEAKER_REVIEW_ENABLED ? undefined : true}>
          {SPEAKER_REVIEW_ENABLED ? (
            <Card padding={4}>
              {/* Folded, unless names typed earlier bring the dialog back: it is in this card, and opens by itself. */}
              <Collapsible
                defaultIsOpen={hasNamesDraft(namesDraftKey)}
                trigger={
                  <>
                    <Text weight="medium">Talare</Text>{" "}
                    <Text color="secondary">{speakerRows.map((row) => row.name || speakerDisplayLabel(row.label)).join(", ")}</Text>
                  </>
                }
              >
                <VStack gap={3} paddingBlockStart={3}>
                  <Text as="p" type="supporting">Namn gäller för talaren i hela transkriberingen. För att byta vem som säger vissa ord, markera orden nedan.</Text>
                  {speakers}
                  {unmappedNote}
                </VStack>
              </Collapsible>
            </Card>
          ) : (
            <VStack gap={6}>
              {intro}
              {/* The card is the speakers, its heading and its action in one row as the transcript's card has them; the
                  decision is the page's, under the card. Not docked on a phone: the transcript's player docks there,
                  and two bars would cover a fifth of the screen. */}
              <Card padding={4} role="group" aria-labelledby="review-speakers">
                <VStack gap={3}>
                  <HStack hAlign="between" vAlign="center" wrap="wrap" gap={2}>
                    <Heading level={2} id="review-speakers">
                      Talare
                    </Heading>
                    {namingAction}
                  </HStack>
                  {speakerList}
                  {unmappedNote}
                </VStack>
              </Card>
              {decision}
            </VStack>
          )}
          {/* There the card folds away, so the decision follows it instead. */}
          {SPEAKER_REVIEW_ENABLED && decision}

          {/* The card's title, as the result's transcript has one: its parts ("Del 1") are h3s under it. */}
          <TranscriptPlayer
            title="Transkribering"
            className={styles.transcriptCard}
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
            onRenameSpeaker={namingAction ? (label, returnTo) => namingDialog.current?.open(label, returnTo) : undefined}
          />
        </div>
      </VStack>
    );
  }

  return (
    <VStack gap={6} className={styles.reading}>
      <VStack gap={1}>
        {paused}
        <Heading level={1} ref={heading} tabIndex={-1}>
          {title}
        </Heading>
        <Text as="p" type="supporting">
          {editable
            ? "Du kan ändra texten innan du godkänner och fortsätter."
            : "Granska innehållet och välj om flödet ska fortsätta."}
        </Text>
        {deadline}
      </VStack>

      <VStack as="section" gap={3} className={styles.card}>
        {/* The text's name and the editor's buttons stay at the top of the window while a long text is read or edited. */}
        <HStack gap={2} wrap="wrap" hAlign="between" vAlign="center" className={styles.cardHead}>
          <VStack gap={1}>
            <Text weight="semibold">Innehåll för granskning</Text>
            {!editable && <Text as="p" type="supporting">Skrivskyddat</Text>}
          </VStack>
          {/* The editor's own buttons, no decision: small, beside the text's name. Spara ändring keeps a change in Eneo
              without going on, and is there only while there is one; Avbryt stays where it is when it comes. */}
          {editable && (
            <HStack gap={2} wrap="wrap">
              {editing ? (
                <>
                  <Button
                    key="avbryt"
                    variant="ghost"
                    size="sm"
                    label="Avbryt"
                    isDisabled={busy}
                    onClick={() => {
                      handOff.current = editButton;
                      setText(initialText);
                      setEditing(false);
                      draft.drop();
                    }}
                  />
                  {dirty && <Button key="spara" variant="secondary" size="sm" label="Spara ändring" isLoading={saving} isDisabled={busy} onClick={saveOnly} />}
                </>
              ) : (
                <Button
                  key="redigera"
                  ref={editButton}
                  variant="secondary"
                  size="sm"
                  icon={<Pencil aria-hidden />}
                  label="Redigera"
                  isDisabled={busy}
                  onClick={() => {
                    handOff.current = textField;
                    setEditing(true);
                  }}
                />
              )}
            </HStack>
          )}
        </HStack>

        {editable && editing ? (
          <TextArea
            ref={textField}
            className={styles.reviewText}
            label="Innehåll för granskning"
            isLabelHidden
            value={text}
            isReadOnly={busy}
            onChange={editText}
            // A field the window holds whole is brought into it with its focus frame; a longer one stays where it is read.
            onFocus={(event) => {
              const field = event.currentTarget;
              if (field.getBoundingClientRect().height <= window.innerHeight) field.scrollIntoView({ block: "nearest", inline: "nearest" });
            }}
            // Where the field cannot size itself to the text (ReviewView.module.css), a height from its lines.
            rows={Math.min(24, Math.max(4, text.split("\n").length + 1))}
          />
        ) : (
          <article className={styles.text}>
            {/* Approved, the decision is what the pause holds, whatever the page had in hand. */}
            <Markdown>{decided ? initialText : text}</Markdown>
          </article>
        )}
      </VStack>

      <VStack gap={3} className={styles.notices}>
        {draft.yours && decided && (
          // Kept to copy, never to continue with: the approved text above is the decision.
          <Banner
            status="warning"
            title="Din ändring sparades inte"
            description="Granskningen godkändes med texten ovan. Din version visas här om du vill kopiera den."
            collapsible={false}
          >
            <VStack gap={2}>
              {draft.yours.text !== undefined && <Text as="p" className={styles.yours}>{draft.yours.text}</Text>}
              <HStack gap={2} wrap="wrap">
                {draft.yours.text !== undefined && <CopyButton text={draft.yours.text} label="Kopiera din version" size="sm" />}
                <Button size="sm" variant="ghost" label="Ta bort din version" isDisabled={busy} onClick={() => draft.dropYours()} />
              </HStack>
            </VStack>
          </Banner>
        )}
        {draft.yours && !decided && (
          <Banner
            status="warning"
            title="Din ändring sparades inte"
            description="Granskningen har ändrats sedan du började. Här visas den senaste versionen, och din version finns kvar."
            collapsible={false}
          >
            <HStack gap={2} wrap="wrap">
              <Button size="sm" variant="secondary" label="Använd din version" isDisabled={busy} onClick={takeYours} />
              <Button size="sm" variant="ghost" label="Behåll den senaste" isDisabled={busy} onClick={() => draft.dropYours()} />
            </HStack>
          </Banner>
        )}
        {runError && <Banner status="error" title={runError} collapsible={false} />}
        {rejectSection}
      </VStack>
      {/* The decision stays in reach at the window's bottom edge however long the text is. While the reason for a
          rejection is written there is no decision to dock, and no empty bar either. */}
      {actions && (
        <div ref={decisionDock} data-docked-action="" className={styles.dock}>
          {actions}
        </div>
      )}
    </VStack>
  );
}

function extractCheckpointText(payload: Json | null | undefined): string {
  if (!payload) return "";
  const text = (payload as { text?: unknown }).text;
  if (typeof text === "string") return text;
  // Fallback: visa payloaden som JSON så användaren ändå kan granska.
  return "```json\n" + JSON.stringify(payload, null, 2) + "\n```";
}
