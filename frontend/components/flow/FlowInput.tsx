import { FileText } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { FlowAside } from "@/components/flow/FlowAside";
import {
  COUNT_FROM_NAMES,
  createDocument,
  DetailsForm,
  focusSpeakerCount,
  SpeakerCountField,
} from "@/components/flow/DetailsForm";
import { EarlierRuns } from "@/components/flow/EarlierRuns";
import { FlowFrame } from "@/components/flow/FlowFrame";
import { MicrophoneCheck } from "@/components/flow/MicrophoneCheck";
import { MODE_TEXT, ModeCards } from "@/components/flow/ModeCards";
import { ProblemAlert } from "@/components/flow/ProblemAlert";
import { ReadyPanel } from "@/components/flow/ReadyPanel";
import { LiveSheet } from "@/components/flow/LiveSheet";
import { FocusedRecorder, RecordingBar, SignedOutControls } from "@/components/flow/Recorder";
import { useDocumentTitle, useElapsed, useSilence } from "@/components/flow/recording-hooks";
import { UploadPanel } from "@/components/flow/UploadPanel";
import type { useFlowSession } from "@/components/flow/useFlowSession";
import { OfflineBanner } from "@/components/OfflineBanner";
import { resumableRecording, UnsentRecordings, type UnsentList } from "@/components/UnsentRecordings";
import { speakerMappingReviewSteps, type FlowPublished, type RunContract } from "@/lib/api";
import type { EarlierRunsSnapshot } from "@/lib/earlier-runs";
import {
  labelsSpeakers,
  primaryActionLabel,
  readSpeakerCount,
  storageLine,
  type SessionPhase,
} from "@/lib/flow-session";
import { browserStorage } from "@/lib/browser-storage";
import { useDock } from "@/lib/dock";
import { createActionLabel, makesText } from "@/lib/flow-output";
import { recentNames, rememberNames } from "@/lib/participants";
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

// Phone width, where the setup's primary action docks at the bottom of the page: just under the 768 px where the CSS takes over.
const PHONE = "(max-width: 767.98px)";
const subscribePhone = (onChange: () => void) => {
  const query = window.matchMedia(PHONE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
const isPhone = () => window.matchMedia(PHONE).matches;

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
  earlierRuns,
  onOpenRun,
  onMoreRuns,
  unsent,
  afterRun = false,
}: {
  published: FlowPublished;
  contract: RunContract;
  input: Session;
  ownerId: string;
  /** A problem from following an earlier run. */
  notice: string | null;
  earlierRuns: EarlierRunsSnapshot;
  onOpenRun: (runId: string) => void;
  onMoreRuns: () => void;
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [dockSlot, dockRef] = useDock();
  const phone = useSyncExternalStore(subscribePhone, isPhone, () => false);
  // Unfolded by a required detail the send found missing, and kept so while it is filled in.
  const openDetails = keepDetailsOpen(detailsOpen, snapshot.invalid);
  if (openDetails !== detailsOpen) setDetailsOpen(openDetails);
  const fields = contract.form_fields ?? [];
  // The flow's own count field, when the names filled it in: said under it, as under this module's field.
  const ownCountField = contract.transcription?.max_speakers?.form_field;
  // What the run makes, which the actions and the lines about it say: text, or a document.
  const text = makesText(contract.final_output);

  useEffect(() => setSuggestions(recentNames(browserStorage(), ownerId)), [ownerId]);

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
            classification={contract.security_classification}
            compact={holdsAudio}
            details={details}
            summary={fields.length > 0 ? detailsSummary(fields, snapshot.details) : null}
            open={openDetails}
            onOpenChange={setDetailsOpen}
            // While recording the details scroll on their own; the side room keeps a focused field's outline inside the scroll box.
            className={group === "capture" ? styles.capturePane : undefined}
          />
        }
      >
        {/* Recording state changes are said once here; the timer never is. */}
        <VisuallyHidden as="p" role="status">
          {recordingAnnouncement(phase)}
        </VisuallyHidden>
        <VStack
          as="section"
          ref={workspace}
          aria-label="Ljudet"
          gap={group === "capture" ? 4 : 6}
          className={group === "capture" ? [styles.capturePane, styles.capture].join(" ") : group === "setup" ? styles.setup : undefined}
        >
          <OfflineBanner waiting={group === "capture" ? "recording" : null} />
          {notice && <ProblemAlert problem={{ title: notice }} />}
          {group === "setup" ? (
            <SetupWorkspace
              contract={contract}
              input={input}
              dock={phone ? dockSlot : null}
              earlierRuns={earlierRuns}
              onOpenRun={onOpenRun}
              onMoreRuns={onMoreRuns}
              unsent={unsent}
            />
          ) : group === "ready" && snapshot.recording ? (
            <ReadyPanel
              recording={snapshot.recording}
              persistent={input.persistent}
              problem={snapshot.problem}
              live={snapshot.live}
              finishing={snapshot.finishing}
              makesText={text}
              onCreate={() => void createDocument(session)}
              onContinue={input.continueStopped}
              onDiscard={() => void session.discard()}
              earlierRuns={earlierRuns}
              onOpenRun={onOpenRun}
              onMoreRuns={onMoreRuns}
            />
          ) : (
            <CaptureWorkspace
              input={input}
              speakers={labelsSpeakers(contract.transcription?.speaker_labels, snapshot.speakerLabels)}
              makesText={text}
            />
          )}
        </VStack>
        {/* The page's own bottom edge, so a docked action stays in reach over the whole setup, however long its
            form; inside main (it is the page's action), over main's side and bottom padding. Only in setup: empty,
            it would let a recording scroll. On a short screen it stays at the page's end instead of covering it. */}
        {group === "setup" && <div ref={dockRef} className={styles.dock} />}
      </FlowFrame>
    </>
  );
}

/** Recording: the focused recorder (Spela in) or the document sheet (Strömma), above the bar, which never moves. */
function CaptureWorkspace({ input, speakers, makesText }: { input: Session; speakers: boolean; makesText: boolean }) {
  const { session, snapshot, capture, persistent } = input;
  const { phase, problem, live, mode } = snapshot;
  const streaming = mode === "stromma" && live !== null;
  const silent = useSilence(capture.stream, phase === "recording");
  const wakeLock = "wakeLock" in navigator;
  const { warnings, notes } = recordingNotices({
    phase,
    silent,
    lowSpace: capture.lowSpace,
    persistent: persistent !== false,
    refused: capture.refused,
    remainingMs: capture.remainingMs,
    muted: capture.muted,
    wakeLock,
    makesText,
  });
  return (
    <>
      {problem && <ProblemAlert problem={problem} onRetry={() => void session.continueRecording()} />}
      {streaming ? (
        <LiveSheet live={live} recorder={capture.status} speakers={speakers} />
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
        onStop={() => void session.stop()}
      />
      <RecordingBar
        capture={session.capture}
        phase={phase}
        stream={capture.stream}
        showStatus={streaming}
        warnings={warnings}
        notes={notes}
        makesText={makesText}
        onPause={() => (phase === "interrupted" ? void session.continueRecording() : session.togglePause())}
        onStop={() => void session.stop()}
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
  onOpenRun,
  onMoreRuns,
  unsent,
}: {
  contract: RunContract;
  input: Session;
  /** On a phone: the page's bottom edge, where the primary action docks. */
  dock: HTMLElement | null;
  earlierRuns: EarlierRunsSnapshot;
  onOpenRun: (runId: string) => void;
  onMoreRuns: () => void;
  unsent: UnsentList;
}) {
  const { session, snapshot, persistent } = input;
  const { modes, mode, phase, problem, file, fileChecking } = snapshot;
  // Only Ladda upp waits for a file's length; the recording modes keep their own start action.
  const checkingUpload = mode === "ladda-upp" && fileChecking;
  const speakerOption = contract.transcription?.speaker_labels;
  const recordingMode = mode === "spela-in" || mode === "stromma";
  const fileInput = useRef<HTMLInputElement>(null);
  const step = selectRuntimeInputStep(contract);
  const audio = step?.input_format?.toLowerCase() === "audio";
  // The flow runs without a file too: Skapa dokument sends the details alone, and choosing a file stays offered.
  const optionalFile = step?.required === false;
  const ActionIcon = mode === "ladda-upp" && (file || optionalFile) ? FileText : mode ? MODE_TEXT[mode].icon : null;
  const reviewsSpeakers = speakerMappingReviewSteps(contract).length > 0;
  const text = makesText(contract.final_output);
  const create = createActionLabel(text);
  // The session refuses the setup's actions while the count is no count; its field takes the focus to put it right.
  const countInvalid = readSpeakerCount(snapshot.speakerCount) === "invalid";
  const onContinue = modes.includes("spela-in")
    ? (recording: StoredRecording) => (countInvalid ? focusSpeakerCount() : void session.continueCutOff(recording))
    : undefined;
  // A meeting a reload cut off goes on with its own "Fortsätt spela in", the one filled action meanwhile, until the
  // person chooses a file to send instead.
  const resuming = onContinue !== undefined && resumableRecording(unsent.recordings) !== undefined && !(mode === "ladda-upp" && file);
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

  const speakerChoice =
    speakerOption?.selectable && snapshot.speakerLabels !== null ? (
      <Switch
        label="Märk upp talare"
        description="Tar längre tid efter inspelningen."
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

  return (
    <VStack gap={6}>
      <UnsentRecordings
        list={unsent}
        // Said apart from the setup's own action, which sends a chosen file or a new recording.
        sendLabel={() => `${create} av inspelningen`}
        filled={resuming}
        evictable={input.evictable}
        onSend={(recording) => {
          if (countInvalid) return focusSpeakerCount();
          session.adopt(recording);
          void createDocument(session);
        }}
        onContinue={onContinue}
      />

      {modes.length > 1 ? (
        <ModeCards modes={modes} mode={mode} onSelect={(next) => session.selectMode(next)} />
      ) : (
        // No choice to ask about: the setup is named by its one way (or by what it makes), so focus has a place to go.
        <VisuallyHidden as="h2" data-phase-heading tabIndex={-1}>
          {modes[0] ? MODE_TEXT[modes[0]].name : create}
        </VisuallyHidden>
      )}

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

      {recordingMode && <MicrophoneCheck active={phase === "setup"} />}

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

      {problem && <ProblemAlert problem={problem} onRetry={() => void session.start()} reveal />}

      {(mode || modes.length === 0) &&
        docked(
          dock,
          // On a phone the one primary action stays in reach at the page's bottom, above the safe area.
          <VStack data-docked-action={dock ? "true" : undefined} gap={dock ? 2 : 3} className={dock ? styles.docked : undefined}>
            <Button
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
              {checkingUpload ? "Kontrollerar filen…" : ""}
            </VisuallyHidden>
            {recordingMode && (
              <Text as="p" type="supporting" justify="center">
                {storageLine(persistent, input.evictable)}
              </Text>
            )}
          </VStack>,
        )}

      <EarlierRuns list={earlierRuns} onOpen={onOpenRun} onMore={onMoreRuns} className={styles.earlier} />
    </VStack>
  );
}
