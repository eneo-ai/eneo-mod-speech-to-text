import { useTranscriptCorrections } from "@/components/useTranscriptCorrections";

import { CheckCircle2, UsersRound } from "lucide-react";
import { SPEAKER_REVIEW_ENABLED } from "@/lib/speaker-review";
import {
  useEffect,
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
import { HStack } from "@astryxdesign/core/HStack";
import { List, ListItem } from "@astryxdesign/core/List";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
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
import {
  buildEditedMapping,
  buildSpeakerRows,
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
import { hasNamesDraft, SpeakerNamingDialog } from "@/components/SpeakerNamingDialog";
import { SpeakerMark, TranscriptPlayer } from "@/components/TranscriptPlayer";
import { useTranscriptContext } from "@/components/useTranscriptContext";
import { useConfirmedWords } from "@/components/useConfirmedWords";
import { confirmedWordsStorageKey } from "@/lib/confirmed-words";
import { isRecord } from "@/lib/is-record";
import { formatDeadline } from "@/lib/format";
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
  checkpoint,
  runState,
  runError,
  onContinue,
  onSaveEdit,
  onReject,
}: {
  flowId: string;
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
      ? "Granska transkriberingen"
      : "Vem är vem?"
    : (checkpoint.step_label ?? "Granska resultatet");
  const heading = usePhaseHeading(title);
  // Eneo ends an unanswered review at this time. Saying so does not meet WCAG 2.2.1 by itself: only a review window
  // longer than 20 hours does (Eneo's default is 14 days; a flow can set less).
  const deadline = checkpoint.expires_at ? (
    <Text as="p" type="supporting">
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
  const [transcript, reloadTranscript] = useTranscriptContext({
    flowId,
    runId,
    enabled: isSpeakerMapping,
    source: getSpeakerMappingSourceStep(payload),
    fallbackText: initialText,
    labelFor: (speaker) => reverseNames[speaker] ?? speaker,
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
        description="Ange en kort motivering. Körningen kommer att avbrytas."
        placeholder="Skäl …"
        rows={3}
        value={rejectReason}
        onChange={setRejectReason}
      />
      <HStack gap={2} hAlign="end">
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
      </HStack>
    </VStack>
  ) : null;

  // The choice as a pair at the end of the bar, of one height: Avvisa, then the action the page exists for.
  const actions = rejecting ? null : (
    <HStack gap={3} hAlign="end" vAlign="center" wrap="wrap" className={isSpeakerMapping ? undefined : styles.textActions}>
      {decided ? (
        <StackItem size="fill">
          <Text as="p" type="supporting">
            {isSpeakerMapping ? "Namnen är redan sparade." : "Granskningen är redan godkänd."} Välj Fortsätt så går flödet vidare.
          </Text>
        </StackItem>
      ) : (
        <Button
          ref={rejectButton}
          variant="secondary"
          size="lg"
          label="Avvisa"
          isDisabled={busy}
          onClick={() => {
            handOff.current = reasonField;
            setShowReject(true);
          }}
        />
      )}
      <Button
        variant="primary"
        size="lg"
        icon={<CheckCircle2 aria-hidden />}
        label={decided ? "Fortsätt" : dirty ? "Spara och fortsätt" : "Godkänn och fortsätt"}
        isLoading={working === "approve"}
        isDisabled={busy || continueBlocked}
        onClick={() => void saveAndApprove()}
      />
    </HStack>
  );

  // Who is who: the decision, and what stops it, directly under Namnge talarna at every width, never after the
  // whole transcript.
  const decision = (
    <VStack gap={4} className={styles.decision}>
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

  const paused = (
    <Text as="p" type="supporting">
      Väntar på din granskning
    </Text>
  );

  if (isSpeakerMapping) {
    // Who is who at a glance; naming happens in "Namnge talarna".
    const speakers =
      speakerRows.length === 0 ? (
        <Text as="p" type="supporting">
          Inga talare kunde urskiljas i transkriberingen. Du kan fortsätta utan att namnge någon.
        </Text>
      ) : (
        <VStack gap={3}>
          <List aria-label="Talare" density="compact" hasDividers>
            {namingRows.map((row) => (
              <ListItem
                key={row.label}
                label={speakerDisplayLabel(row.label)}
                startContent={<SpeakerMark label={row.label} name={row.name ?? speakerDisplayLabel(row.label)} />}
                description={<Text color={row.name ? undefined : "secondary"}>{row.name ?? "Inget namn"}</Text>}
              />
            ))}
          </List>
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
            decided={decided}
            draftKey={namesDraftKey}
          >
            <Button variant="secondary" icon={<UsersRound aria-hidden />} label="Namnge talarna" isDisabled={busy} className={styles.selfStart} />
          </SpeakerNamingDialog>
        </VStack>
      );
    const unmappedNote = unmapped.length > 0 && speakerRows.length > 0 && (
      <Text as="p" type="supporting">
        Talare utan namn behåller sin etikett i transkriberingen.
      </Text>
    );

    return (
      <VStack gap={0}>
        <VStack gap={1} className={styles.intro}>
          {paused}
          <Heading level={1} ref={heading} tabIndex={-1}>
            {title}
          </Heading>
          <Text as="p" type="supporting" className={styles.description}>
            {SPEAKER_REVIEW_ENABLED ? "Lyssna, markera ord och välj vem som säger dem. Du kan också rätta texten." : "Lyssna och sätt namn på talarna. Namnen skrivs in i transkriberingen när du fortsätter."}
          </Text>
          {deadline}
        </VStack>

        {/* One column that may shrink below its content: the speaker chips scroll instead of widening the page. */}
        <div className={SPEAKER_REVIEW_ENABLED ? styles.review : styles.reviewSplit}>
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
            <Card padding={4} role="group" aria-label="Talare">
              <VStack gap={3}>
                {speakers}
                {unmappedNote}
              </VStack>
              {decision}
            </Card>
          )}
          {/* There the card folds away, so the decision follows it instead. */}
          {SPEAKER_REVIEW_ENABLED && decision}

          {/* The card shows no title, but its parts ("Del 1") are h3s under this one. */}
          <VisuallyHidden as="h2">Transkribering</VisuallyHidden>
          <TranscriptPlayer
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
          />
        </div>
      </VStack>
    );
  }

  return (
    <VStack gap={0} className={styles.reading}>
      <VStack gap={1} className={styles.intro}>
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
        <HStack hAlign="between" vAlign="center">
          <Text weight="semibold">Innehåll för granskning</Text>
          <Text type="supporting">{editable ? "Redigerbart" : "Skrivskyddat"}</Text>
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
            onFocus={(event) => event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" })}
            rows={Math.min(24, Math.max(8, text.split("\n").length + 1))}
          />
        ) : (
          <article>
            {/* Approved, the decision is what the pause holds, whatever the page had in hand. */}
            <Markdown>{decided ? initialText : text}</Markdown>
          </article>
        )}

        {editable && (
          <HStack gap={2} hAlign="end">
            {editing ? (
              <>
                <Button
                  key="avbryt"
                  variant="ghost"
                  label="Avbryt"
                  isDisabled={busy}
                  onClick={() => {
                    handOff.current = editButton;
                    setText(initialText);
                    setEditing(false);
                    draft.drop();
                  }}
                />
                <Button key="spara" variant="secondary" label="Spara ändring" isLoading={saving} isDisabled={!dirty || busy} onClick={saveOnly} />
              </>
            ) : (
              <Button
                key="redigera"
                ref={editButton}
                variant="ghost"
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
      {actions}
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
