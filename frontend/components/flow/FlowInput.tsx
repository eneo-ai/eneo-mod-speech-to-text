import { FileText } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { BackToFlows } from "@/components/flow/BackToFlows";
import { ClassificationLine, ClassificationNote } from "@/components/flow/ClassificationNote";
import { FlowAside } from "@/components/flow/FlowAside";
import {
  COUNT_FROM_NAMES,
  createDocument,
  DetailsForm,
  focusSpeakerCount,
  SpeakerCountField,
} from "@/components/flow/DetailsForm";
import { EarlierRuns, LatestRuns, pendingReviewSaid } from "@/components/flow/EarlierRuns";
import { FlowFrame } from "@/components/flow/FlowFrame";
import { HowItWorks } from "@/components/flow/HowItWorks";
import { MicrophoneCheck } from "@/components/flow/MicrophoneCheck";
import { MODE_TEXT, ModeCards } from "@/components/flow/ModeCards";
import { ProblemAlert } from "@/components/flow/ProblemAlert";
import { ReadyPanel } from "@/components/flow/ReadyPanel";
import { StateCard } from "@/components/flow/StateCard";
import { LiveSheet } from "@/components/flow/LiveSheet";
import { FocusedRecorder, RecordingBar, SignedOutControls } from "@/components/flow/Recorder";
import { useDocumentTitle, useElapsed, useSaidLater, useSilence } from "@/components/flow/recording-hooks";
import { UploadPanel } from "@/components/flow/UploadPanel";
import type { useFlowSession } from "@/components/flow/useFlowSession";
import { useSignedOut } from "@/components/AuthGate";
import { OfflineBanner } from "@/components/OfflineBanner";
import { resumableRecording, UnsentRecordings, type UnsentList } from "@/components/UnsentRecordings";
import { speakerMappingReviewSteps, type FlowPublished, type RunContract } from "@/lib/api";
import { latestRuns, listsMore, type EarlierRunsList, type EarlierRunsSnapshot } from "@/lib/earlier-runs";
import {
  captureLimits,
  labelsSpeakers,
  primaryActionLabel,
  readSpeakerCount,
  speakerLabelsGap,
  SPEAKERS_UNAVAILABLE,
  storageLine,
  type SessionPhase,
} from "@/lib/flow-session";
import { browserStorage } from "@/lib/browser-storage";
import { useDock } from "@/lib/dock";
import { createActionLabel, forwardedLine, howItWorks, makesText } from "@/lib/flow-output";
import { lastNames, recentNames, rememberNames } from "@/lib/participants";
import type { StoredRecording } from "@/lib/recording-store";
import {
  detailsSummary,
  keepDetailsOpen,
  pageTitle,
  recordingAnnouncement,
  recordingNotices,
} from "@/lib/recording-view";
import { selectRuntimeInputStep } from "@/lib/upload";
import styles from "./FlowSetup.module.css";

type Session = ReturnType<typeof useFlowSession>;

// Focus moves to the new state's heading when the page changes state, never within one.
const PHASE_GROUP: Record<SessionPhase, "setup" | "capture" | "ready"> = {
  setup: "setup",
  starting: "setup",
  recording: "capture",
  paused: "capture",
  interrupted: "capture",
  ready: "ready",
};

/** How long the browser's question about the microphone may be left before the page says where it is. */
const MICROPHONE_ANSWER_WAIT_MS = 3_000;
const ASK_THE_BROWSER = "Svara på frågan i webbläsaren.";
const REMOVED = "Inspelningen togs bort.";

const PHONE = "(max-width: 767.98px)";
// A small phone's window: the dock keeps to the action, so the ways in have the room above it.
const SHORT = "(max-height: 640px)";
// A touch screen, which locks and whose apps switch under a recording, tall enough that the bar's line about it leaves the
// text its room; on a smaller one the line stands only among the tips before the start ("Tips för bra ljud", under the
// microphone's test).
const TOUCH = "(pointer: coarse) and (min-height: 640px)";
// From a laptop's width the flow stands in a column beside the work (FlowFrame); below it, the flow comes first.
const COLUMNS = "(min-width: 1024px)";

/** The tab title follows the state; its own component, so the timer re-renders only this. */
function TabTitle({ input, flowName }: { input: Session; flowName: string }) {
  const { phase } = input.snapshot;
  const elapsed = useElapsed(input.session.capture, phase === "recording");
  useDocumentTitle(pageTitle(phase, elapsed, flowName, input.snapshot.problem?.sent === true));
  return null;
}

/** The flow page before a run: the details, and the audio given one of three ways. */
export function FlowInput({
  published,
  contract,
  input,
  ownerId,
  notice,
  earlier,
  onOpenRun,
  unsent,
  afterRun = false,
}: {
  published: FlowPublished;
  contract: RunContract;
  input: Session;
  ownerId: string;
  /** A problem from following an earlier run. */
  notice: string | null;
  /** This user's earlier runs of the flow: the setup's own to follow, so a read never draws a run's view again. */
  earlier: EarlierRunsList;
  onOpenRun: (runId: string) => void;
  unsent: UnsentList;
  /** In place of a run's view (Ny inspelning, Avbryt during an upload): the heading takes the focus, as on a change of state. */
  afterRun?: boolean;
}) {
  const { session, snapshot } = input;
  const { phase, mode } = snapshot;
  const group = PHASE_GROUP[phase];
  const holdsAudio = group !== "setup";
  const workspace = useRef<HTMLElement>(null);
  const shownGroup = useRef(group);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  // The names each list field was last sent with on this flow, offered in one press where the field has none.
  const [previous, setPrevious] = useState<Record<string, string[]>>({});
  const [detailsOpen, setDetailsOpen] = useState(false);
  // "Ta bort" took the ready recording away: said in the page's status (nothing shown moves the setup), until a recording begins.
  const [removed, setRemoved] = useState(false);
  if (removed && group !== "setup") setRemoved(false);
  // The runs as the setup opened with them (on the page's load, or back from a run's view): a read that lands while it is
  // open, one a run's view started or Visa fler körningar, changes the list at the working card's end, never the latest
  // runs above the form.
  const earlierRuns = useSyncExternalStore(earlier.subscribe, earlier.getSnapshot, earlier.getSnapshot);
  const onMoreRuns = () => void earlier.more();
  const [opened] = useState(earlierRuns);
  // A run waiting for the person's review, said in the page's status once the latest runs show it: they arrive with the
  // setup, which a screen reader does not reliably read out.
  const reviewSaid = useSaidLater(group === "setup" ? pendingReviewSaid(opened) : "");
  const [dockSlot, dockRef] = useDock();
  const phone = useMediaQuery(PHONE);
  const columns = useMediaQuery(COLUMNS);
  const short = useMediaQuery(SHORT);
  // Unfolded by a required detail the send found missing, and kept so while it is filled in.
  const openDetails = keepDetailsOpen(detailsOpen, snapshot.invalid);
  if (openDetails !== detailsOpen) setDetailsOpen(openDetails);
  const fields = contract.form_fields ?? [];
  // The flow's own count field, when the names filled it in: said under it, as under this module's field.
  const ownCountField = contract.transcription?.max_speakers?.form_field;
  // What the run makes, which the actions and the lines about it say: text, or a document.
  const text = makesText(contract.final_output);
  // A flow that cannot run now: the session takes no way on, so none is offered, in the setup or over a recording
  // that was ready before.
  const blocked = speakerLabelsGap(contract.transcription?.speaker_labels) === "blocked";
  // The setup's unsent recordings: a send takes one up as the document's input, and "Fortsätt spela in" records on in
  // one a reload cut off. The session refuses both while the count is no count; its field takes the focus to put it right.
  const countInvalid = readSpeakerCount(snapshot.speakerCount) === "invalid";
  const onContinue = snapshot.modes.includes("spela-in")
    ? (recording: StoredRecording) => (countInvalid ? focusSpeakerCount() : void session.continueCutOff(recording))
    : undefined;
  // A meeting a reload cut off goes on with its own "Fortsätt spela in", the one filled action meanwhile, until the
  // person chooses a file to send instead.
  const resuming = onContinue !== undefined && resumableRecording(unsent.recordings) !== undefined && !(mode === "ladda-upp" && snapshot.file);
  const unsentRecordings = (
    <UnsentRecordings
      list={unsent}
      sendLabel={() => `${createActionLabel(text)} av inspelningen`}
      filled={resuming}
      evictable={input.evictable}
      onSend={(recording) => {
        if (countInvalid) return focusSpeakerCount();
        session.adopt(recording);
        void createDocument(session);
      }}
      onContinue={onContinue}
    />
  );
  // In one column the flow's details stand above the work: the recording to go on with comes first, under its name.
  const recoveryFirst = group === "setup" && !blocked && resuming && !columns;
  // In one column the choice of way in comes first, so the chosen way is on the first screen with the docked action that
  // starts it; the flow's classification follows the choice there. The details stand in the working card at every width,
  // by the speaker controls they fill in, so a field being typed in never moves when the layout changes (a tablet turned).
  const choiceFirst = group === "setup" && !blocked && !columns;
  // "Så fungerar det" is read once, before the meeting: beside the work from a laptop's width, and in one column one folded
  // row above the choice, under the latest runs. A short screen in one column (a small phone, one on its side) keeps its
  // first screen for the ways in and the docked action: there the guide follows the work. A laptop's flow column has the
  // room at any height.
  // On a phone the flow's description opens the guide instead of standing above the choice: the person has just read it in
  // the flow's row of the list.
  const guide = group === "setup" ? howItWorks(contract, snapshot.modes) : null;
  const guideInColumn = choiceFirst ? guide : null;
  const guideAbove = short ? null : guideInColumn;
  const guideAfter = short ? guideInColumn : null;
  const descriptionInGuide = guideInColumn !== null && phone && Boolean(published.description);
  const guideLead = descriptionInGuide && <Text as="p" color="secondary">{published.description}</Text>;
  // The latest runs open the setup, under the flow's name at every width (beside the work from a laptop's width, so the
  // working card keeps its action on the first screen): three, and two on a phone, whose first screen then still reaches
  // the choice of way in under a browser's own bars. A short screen in one column shows only those waiting for review:
  // its first screen is the ways in's. The blocked setup's card lists its runs right under the reason. Where the latest
  // runs are all of them, they are the list: the working card lists the runs only while it has more (a read that landed
  // later, more in Eneo, a read to try again).
  const waitingOnly = short && !columns;
  const latest = group === "setup" && !blocked ? latestRuns(opened.runs, { waitingOnly, count: phone ? 2 : 3 }) : [];
  const latestRunsShown = (
    <LatestRuns runs={latest} more={listsMore(opened, latest)} waitingOnly={waitingOnly} onOpen={onOpenRun} className={styles.runs} />
  );

  useEffect(() => setSuggestions(recentNames(browserStorage(), ownerId)), [ownerId]);
  useEffect(
    () =>
      setPrevious(
        Object.fromEntries(fields.filter((field) => field.type === "list").map((field) => [field.name, lastNames(browserStorage(), ownerId, contract.flow_id, field.name)])),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ownerId, contract],
  );

  // Never on the page's first load, where the page starts from its top.
  useEffect(() => {
    if (afterRun) workspace.current?.querySelector<HTMLElement>("[data-phase-heading]")?.focus();
  }, []);

  useEffect(() => {
    if (shownGroup.current === group) return;
    shownGroup.current = group;
    workspace.current?.querySelector<HTMLElement>("[data-phase-heading]")?.focus();
  }, [group]);

  const details = (
    <DetailsForm
      fields={fields}
      details={snapshot.details}
      invalid={snapshot.invalid}
      onChange={(name, value) => session.setDetail(name, value)}
      makesText={text}
      suggestions={suggestions}
      previous={previous}
      onNamesAdded={(names) => rememberNames(browserStorage(), ownerId, names)}
      notes={ownCountField && snapshot.speakerCountFromNames ? { [ownCountField]: COUNT_FROM_NAMES } : undefined}
      countField={ownCountField}
    />
  );

  return (
    <>
      <TabTitle input={input} flowName={published.name} />
      <FlowFrame
        fill={group === "capture"}
        aside={
          <FlowAside
            published={published}
            classification={choiceFirst ? null : contract.security_classification}
            compact={holdsAudio}
            described={!descriptionInGuide}
            guide={columns ? guide : null}
            lead={
              recoveryFirst ? (
                <>
                  {unsentRecordings}
                  {latestRunsShown}
                </>
              ) : (
                latestRunsShown
              )
            }
            // In the setup the details are the working card's; while the page holds audio they are the flow's, folded on
            // a phone or tablet. The blocked setup asks for nothing: its details would be filled in for no run. What was
            // typed before stays with the session.
            details={group === "setup" ? null : details}
            summary={fields.length > 0 ? detailsSummary(fields, snapshot.details) : null}
            open={openDetails}
            onOpenChange={setDetailsOpen}
            // While recording the details scroll on their own; the side room keeps a focused field's outline inside the scroll box.
            className={group === "capture" ? styles.capturePane : undefined}
          />
        }
      >
        <VStack
          as="section"
          ref={workspace}
          aria-label="Ljudet"
          gap={group === "capture" ? 4 : 6}
          className={group === "capture" ? [styles.capturePane, styles.capture].join(" ") : group === "setup" ? styles.setup : undefined}
        >
          {/* Recording state changes are said once here; the timer never is. Inside the section, so they are still heard
              when Strömma shows the section alone on the whole screen: a browser then hides the rest of the page from
              assistive technology. */}
          <VisuallyHidden as="p" role="status">
            {removed ? REMOVED : group === "setup" ? reviewSaid : recordingAnnouncement(phase)}
          </VisuallyHidden>
          <OfflineBanner waiting={group === "capture" ? "recording" : null} saved={input.persistent === true && input.capture.refused === null} />
          {notice && <ProblemAlert problem={{ title: notice }} />}
          {/* The recordings to go on with or send stand above the working card, a card of their own beside it, never in it. */}
          {group === "setup" && !blocked && !recoveryFirst && unsentRecordings}
          {guideAbove && <HowItWorks guide={guideAbove} lead={guideLead} />}
          {group === "setup" ? (
            <SetupWorkspace
              contract={contract}
              input={input}
              dock={columns ? null : dockSlot}
              earlierRuns={earlierRuns}
              listsEarlier={listsMore(earlierRuns, latest)}
              onOpenRun={onOpenRun}
              onMoreRuns={onMoreRuns}
              unsent={unsent}
              resuming={resuming}
              details={details}
              oneColumn={!columns}
            />
          ) : group === "ready" && snapshot.recording ? (
            <ReadyPanel
              recording={snapshot.recording}
              awaitingDevice={snapshot.awaitingDevice}
              persistent={input.persistent}
              problem={snapshot.problem}
              live={snapshot.live}
              finishing={snapshot.finishing}
              finishQueued={snapshot.finishQueued}
              makesText={text}
              forwarded={forwardedLine(contract)}
              // Blocked since the recording was made: neither way on would do anything, so the panel has the reason
              // (the session's problem), saving as a file and deleting.
              onCreate={blocked ? undefined : () => void createDocument(session)}
              onContinue={blocked ? undefined : input.continueStopped}
              onDiscard={() => void session.discard().then((gone) => gone && setRemoved(true))}
              earlierRuns={earlierRuns}
              onOpenRun={onOpenRun}
              onMoreRuns={onMoreRuns}
            />
          ) : (
            <CaptureWorkspace
              input={input}
              speakers={labelsSpeakers(contract.transcription?.speaker_labels, snapshot.speakerLabels)}
              makesText={text}
              room={workspace}
            />
          )}
          {guideAfter && <HowItWorks guide={guideAfter} lead={guideLead} />}
        </VStack>
        {/* The page's own bottom edge, so a docked action stays in reach over the whole setup, however long its
            form; inside main (it is the page's action), over main's side and bottom padding. Only in setup: empty,
            it would let a recording scroll. On a short screen it stays at the page's end instead of covering it. */}
        {group === "setup" && <div ref={dockRef} className={styles.dock} />}
      </FlowFrame>
    </>
  );
}

/**
 * Recording: the focused recorder (Spela in) or the document sheet (Strömma), above the bar, which never moves. `room` is
 * the recording's section, which Strömma can show alone on the whole screen.
 */
function CaptureWorkspace({
  input,
  speakers,
  makesText,
  room,
}: {
  input: Session;
  speakers: boolean;
  makesText: boolean;
  room: RefObject<HTMLElement | null>;
}) {
  const { session, snapshot, capture, persistent } = input;
  const { phase, problem, live, mode } = snapshot;
  const streaming = mode === "stromma" && live !== null;
  const silent = useSilence(capture.stream, phase === "recording");
  const coarsePointer = useMediaQuery(TOUCH);
  const { warnings, cautions, notes } = recordingNotices({
    phase,
    silent,
    lowSpace: capture.lowSpace,
    persistent: persistent !== false,
    refused: capture.refused,
    backOnDevice: capture.backOnDevice,
    remainingMs: capture.remainingMs,
    muted: capture.muted,
    mutedLong: capture.mutedLong,
    mutedGap: capture.mutedGap,
    hiddenGap: capture.hiddenGap,
    stalled: capture.stalled,
    // The recorder's own word on keeping the recording; what a press was answered (the problem) and what a stop ends with
    // (the ready view) are said there.
    error: problem || capture.stopping ? null : capture.error,
    screenLock: capture.screenLock,
    makesText,
    coarsePointer,
  });
  // Stoppa asks first only where it cannot be taken back with Fortsätt spela in: the flow takes no further part of the
  // recording. Asked from the sign-in dialog, the question opens above it; asked from the page, it is closed while the
  // login has ended and back after the new one, as the page's other questions are.
  const signedOut = useSignedOut();
  const [stopAsked, setStopAsked] = useState<{ signedOut: boolean } | null>(null);
  const capturing = phase === "recording" || phase === "paused";
  if (stopAsked && !capturing) setStopAsked(null);
  const stop = () => {
    // Stopping already: a second press asks and stops nothing more.
    if (capture.stopping) return;
    if (capturing && !session.capture.continuesAfterStop()) setStopAsked({ signedOut });
    else void session.stop();
  };
  return (
    <>
      {problem && <ProblemAlert problem={problem} onRetry={() => void session.continueRecording()} />}
      {streaming ? (
        <LiveSheet live={live} recorder={capture.status} speakers={speakers} room={room} />
      ) : (
        <FocusedRecorder
          capture={session.capture}
          phase={phase}
          stream={capture.stream}
        />
      )}
      <SignedOutControls
        phase={phase}
        onPause={() => session.togglePause()}
        onStop={stop}
      />
      <RecordingBar
        capture={session.capture}
        phase={phase}
        stream={capture.stream}
        showStatus={streaming}
        warnings={warnings}
        cautions={cautions}
        notes={notes}
        makesText={makesText}
        stopping={capture.stopping}
        onPause={() => (phase === "interrupted" ? void session.continueRecording() : session.togglePause())}
        onStop={stop}
      />
      {/* Going on is the safe answer, and has the focus; nothing recorded is lost either way. */}
      <AlertDialog
        isOpen={stopAsked !== null && (stopAsked.signedOut || !signedOut)}
        onOpenChange={(open) => !open && setStopAsked(null)}
        title="Stoppa inspelningen?"
        description="Den kan inte fortsätta efteråt. Vill du spela in mer behöver du starta en ny inspelning."
        cancelLabel="Fortsätt spela in"
        actionLabel="Stoppa"
        actionVariant="secondary"
        onAction={() => {
          setStopAsked(null);
          void session.stop();
        }}
      />
    </>
  );
}

/** The action in the page's dock when there is one, else where it stands. */
function docked(dock: HTMLElement | null, action: ReactElement) {
  return dock ? createPortal(action, dock) : action;
}

function SetupWorkspace({
  contract,
  input,
  dock,
  earlierRuns,
  listsEarlier,
  onOpenRun,
  onMoreRuns,
  unsent,
  resuming,
  details,
  oneColumn,
}: {
  contract: RunContract;
  input: Session;
  /** In one column (a phone or tablet): the page's bottom edge, where the primary action docks. */
  dock: HTMLElement | null;
  earlierRuns: EarlierRunsSnapshot;
  /** The list has runs the latest runs above do not show; else they are the list. */
  listsEarlier: boolean;
  onOpenRun: (runId: string) => void;
  onMoreRuns: () => void;
  /** The unsent recordings, listed under the reason when the flow cannot run (only to save as files or delete). */
  unsent: UnsentList;
  /** A recording a reload cut off is the page's one filled action, "Fortsätt spela in". */
  resuming: boolean;
  /** The flow's details, after the choice of way in at every width. */
  details: ReactNode;
  /** One column (below a laptop's width): the flow's classification card follows the details here, not in the flow's column. */
  oneColumn: boolean;
}) {
  const { session, snapshot, persistent } = input;
  const { modes, mode, phase, problem, file, fileChecking } = snapshot;
  const short = useMediaQuery(SHORT);
  // The browser's question about the microphone may wait for an answer that does not come: after a moment the page says
  // where the question is, and Avbryt stops waiting for it.
  const [unanswered, setUnanswered] = useState(false);
  const startButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setUnanswered(false);
    if (phase !== "starting") return;
    const timer = setTimeout(() => setUnanswered(true), MICROPHONE_ANSWER_WAIT_MS);
    return () => clearTimeout(timer);
  }, [phase]);
  // Only Ladda upp waits for a file's length; the recording modes keep their own start action.
  const checkingUpload = mode === "ladda-upp" && fileChecking;
  const speakerOption = contract.transcription?.speaker_labels;
  const recordingMode = mode === "spela-in" || mode === "stromma";
  const fileInput = useRef<HTMLInputElement>(null);
  const step = selectRuntimeInputStep(contract);
  const audio = step?.input_format?.toLowerCase() === "audio";
  // The flow runs without a file too: Skapa dokument sends the details alone, and choosing a file stays offered.
  const optionalFile = step?.required === false;
  const storage = storageLine(persistent, input.evictable, captureLimits(contract, step).maxRecordingMs);
  const ActionIcon = mode === "ladda-upp" && (file || optionalFile) ? FileText : mode ? MODE_TEXT[mode].icon : null;
  const reviewsSpeakers = speakerMappingReviewSteps(contract).length > 0;
  const text = makesText(contract.final_output);
  const create = createActionLabel(text);
  // The session refuses the setup's actions while the count is no count; its field takes the focus to put it right.
  const countInvalid = readSpeakerCount(snapshot.speakerCount) === "invalid";
  const label =
    !mode || (mode === "ladda-upp" && optionalFile)
      ? create
      : !audio && !file
        ? "Välj fil"
        : primaryActionLabel(mode, file != null, text);

  function primary() {
    if (countInvalid) focusSpeakerCount();
    else if (recordingMode) void session.start();
    else if (mode === "ladda-upp" && !file && !optionalFile) fileInput.current?.click();
    else void createDocument(session);
  }

  // Said apart from the setup's own action, which sends a chosen file or a new recording.
  const sendLabel = () => `${create} av inspelningen`;
  const speakerGap = speakerLabelsGap(speakerOption);

  // The flow cannot run now: its reason and the way to another flow stand where the ways in would, so nothing is
  // recorded, chosen or sent. The page's own content from its first paint, so a heading and a paragraph, not an alert.
  // A recording made earlier stays listed under the reason it cannot be sent, in its own card, to save as a file.
  if (speakerGap === "blocked") {
    return (
      <VStack gap={6}>
        <StateCard>
          <VStack gap={4}>
            <Heading level={2} data-phase-heading tabIndex={-1}>
              {SPEAKERS_UNAVAILABLE.title}
            </Heading>
            <Text as="p" data-measure>{SPEAKERS_UNAVAILABLE.detail}</Text>
            <HStack>
              <BackToFlows variant="primary" size="md" />
            </HStack>
          </VStack>
          <EarlierRuns list={earlierRuns} onOpen={onOpenRun} onMore={onMoreRuns} className={[styles.earlier, styles.runs].join(" ")} />
        </StateCard>
        <UnsentRecordings list={unsent} sendLabel={sendLabel} evictable={input.evictable} />
      </VStack>
    );
  }

  const speakerChoice =
    speakerGap === "unlabelled" ? (
      // In the switch's place: it could not be kept, and nothing else about the run changes.
      <Text as="p" color="secondary">
        Talare kan inte märkas upp just nu. Transkriberingen fungerar som vanligt.
      </Text>
    ) : speakerOption?.selectable && snapshot.speakerLabels !== null ? (
      // What it gives, then what it costs. As wide as the working card's content: the card bounds it.
      <Switch
        label="Märk upp talare"
        description={`Texten visar vem som sa vad. Det tar längre tid efter ${mode === "ladda-upp" ? "uppladdningen" : "inspelningen"}.`}
        value={snapshot.speakerLabels}
        onChange={(on) => session.setSpeakerLabels(on)}
        labelPosition="start"
        labelSpacing="spread"
        width="100%"
      />
    ) : speakerOption?.required || reviewsSpeakers ? (
      <Text as="p" color="secondary">
        Flödet märker upp talare.
        {reviewsSpeakers && " Efter transkriberingen bekräftar du vem som är vem."}
      </Text>
    ) : null;

  // The working card: white on the page's tinted ground, beside the flow's column from a laptop's width, its parts 24 px
  // apart (StateCard), so the setup's action is in view on a laptop's first screen.
  return (
    <StateCard>
      {modes.length > 1 ? (
        <ModeCards modes={modes} mode={mode} onSelect={(next) => session.selectMode(next)} note={snapshot.modesNote} />
      ) : (
        <>
          {/* No choice to ask about: the setup is named by its one way (or by what it makes), so focus has a place to go. */}
          <VisuallyHidden as="h2" data-phase-heading tabIndex={-1}>
            {modes[0] ? MODE_TEXT[modes[0]].name : create}
          </VisuallyHidden>
          {snapshot.modesNote && <Text as="p" color="secondary">{snapshot.modesNote}</Text>}
        </>
      )}

      {/* The microphone right under the way it records with: tested before the meeting starts, not after the rest. The
          chosen file the same way: in view under Ladda upp, not under the details, out of sight of the action it sends. */}
      {recordingMode && <MicrophoneCheck active={phase === "setup"} tips={howItWorks(contract, modes)?.tips} />}
      {mode === "ladda-upp" && (
        <UploadPanel
          step={step}
          file={file}
          audio={audio}
          optional={optionalFile}
          inputRef={fileInput}
          onChoose={(chosen) => session.chooseFile(chosen)}
        />
      )}

      {details}

      {/* The count belongs with the speaker choice, so the two stand closer than the setup's other parts. */}
      {(speakerChoice || snapshot.speakerCount !== null) && (
        <VStack gap={4}>
          {speakerChoice}
          {snapshot.speakerCount !== null && (
            <SpeakerCountField
              value={snapshot.speakerCount}
              fromNames={snapshot.speakerCountFromNames}
              onChange={(text) => session.setSpeakerCount(text)}
            />
          )}
        </VStack>
      )}

      {oneColumn && <ClassificationNote classification={contract.security_classification} bare />}

      {/* In one column the dock keeps to the classification and the action, so the ways in stay in view above it: where
          the recording is kept is said at the form's end. */}
      {recordingMode && dock && (
        <Text as="p" type="supporting" data-measure>
          {storage}
        </Text>
      )}

      {problem && <ProblemAlert problem={problem} onRetry={() => void session.start()} reveal />}

      {(mode || modes.length === 0) &&
        docked(
          dock,
          // In one column the one primary action stays in reach at the page's bottom, above the safe area.
          <VStack data-docked-action={dock ? "true" : undefined} gap={dock ? 2 : 3} className={dock ? styles.docked : undefined}>
            {/* Where the person commits in one column: what the flow may take, once more in the dock, where the window
                has room for it (a small phone's leaves it to the note in the card). Elsewhere the classification stands
                in view beside the action (the flow's column). */}
            {dock && !short && <ClassificationLine classification={contract.security_classification} />}
            {forwardedLine(contract) && (
              <Text as="p" type="supporting" justify="center">
                {forwardedLine(contract)}
              </Text>
            )}
            <Button
              ref={startButton}
              label={phase === "starting" ? "Startar…" : checkingUpload ? "Kontrollerar filen…" : label}
              variant={resuming ? "secondary" : "primary"}
              size="lg"
              // Second to "Fortsätt spela in", it is a button of its own size: a bar of the muted colour reads as disabled.
              width={resuming && !dock ? undefined : "100%"}
              icon={ActionIcon ? <Icon icon={ActionIcon} /> : undefined}
              // Busy, not disabled: that would drop keyboard focus while the browser asks for the microphone, and a
              // second press is refused by the session.
              isLoading={phase === "starting" || checkingUpload}
              isInterruptible
              onClick={primary}
            />
            {/* The wait for a chosen file's length is said, not only written on the button. */}
            <VisuallyHidden as="p" role="status">
              {checkingUpload ? "Kontrollerar filen…" : unanswered ? ASK_THE_BROWSER : ""}
            </VisuallyHidden>
            {unanswered && (
              <VStack gap={2} hAlign="center">
                <Text as="p" type="supporting" justify="center" aria-hidden>
                  {ASK_THE_BROWSER}
                </Text>
                <Button label="Avbryt" variant="secondary" onClick={() => {
                  session.cancelStart();
                  startButton.current?.focus();
                }} />
              </VStack>
            )}
            {recordingMode && !dock && (
              <Text as="p" type="supporting" justify="center" data-measure>
                {storage}
              </Text>
            )}
          </VStack>,
        )}

      {listsEarlier && (
        <EarlierRuns list={earlierRuns} onOpen={onOpenRun} onMore={onMoreRuns} className={[styles.earlier, styles.runs].join(" ")} />
      )}
    </StateCard>
  );
}
