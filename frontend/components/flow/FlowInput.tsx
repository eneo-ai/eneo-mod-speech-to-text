"use client";

import { FileText } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { FlowAside } from "@/components/flow/FlowAside";
import {
  COUNT_FROM_NAMES,
  createDocument,
  DetailsForm,
  SPEAKER_COUNT_ID,
  SpeakerCountField,
} from "@/components/flow/DetailsForm";
import { EarlierRuns } from "@/components/flow/EarlierRuns";
import { FlowTopBar } from "@/components/flow/FlowTopBar";
import { FLOW_GRID, FRAME } from "@/components/frame";
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
import { resumableRecording, UnsentRecordings, type UnsentRecording } from "@/components/UnsentRecordings";
import { speakerMappingReviewSteps, type FlowPublished, type RunContract } from "@/lib/api";
import type { EarlierRunsSnapshot } from "@/lib/earlier-runs";
import {
  browserStorage,
  createActionLabel,
  labelsSpeakers,
  makesText,
  primaryActionLabel,
  readSpeakerCount,
  storageLine,
  type SessionPhase,
} from "@/lib/flow-session";
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
import { cn } from "@/lib/utils";

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

// Phone width, where the setup's primary action docks at the bottom of the page.
const PHONE = "(max-width: 767px)";
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
  unsentRecordings,
  onLeave,
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
  unsentRecordings: UnsentRecording[];
  /** The page's links off the flow: they ask first while leaving would lose something (the page owns the question). */
  onLeave: (event: MouseEvent) => void;
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
  const [dockSlot, setDockSlot] = useState<HTMLDivElement | null>(null);
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
    <div className={cn("flex flex-col", group === "capture" ? "h-dvh" : "min-h-dvh")}>
      <TabTitle input={input} flowName={published.name} />
      <FlowTopBar
        title={published.name}
        onLeave={onLeave}
        trailing={
          holdsAudio && mode ? (
            <Badge variant="soft" className="h-8 px-3 text-[14px] font-medium">
              {/* Alone, "Spela in" reads like a command. */}
              <span className="sr-only">Läge: </span>
              {MODE_TEXT[mode].name}
            </Badge>
          ) : undefined
        }
      />
      {/* Recording state changes are said once here; the timer never is. */}
      <p role="status" className="sr-only">
        {recordingAnnouncement(phase)}
      </p>
      <main
        id="innehall"
        className={cn(
          FRAME,
          FLOW_GRID,
          "flex-1 pt-3 lg:pt-8",
          group === "capture"
            ? "flex min-h-0 flex-col overflow-y-auto lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden lg:pb-6"
            : "pb-12 lg:items-start",
        )}
      >
        {/* While recording the details scroll on their own; the side room keeps a focused field's outline inside the scroll box. */}
        <FlowAside
          published={published}
          classification={contract.security_classification}
          onLeave={onLeave}
          compact={holdsAudio}
          details={details}
          summary={fields.length > 0 ? detailsSummary(fields, snapshot.details) : null}
          open={openDetails}
          onOpenChange={setDetailsOpen}
          className={cn(group === "capture" && "lg:-mx-2 lg:min-h-0 lg:overflow-y-auto lg:px-2 lg:pb-2")}
        />

        <section
          ref={workspace}
          aria-label="Ljudet"
          className={cn(
            "flex min-w-0 flex-col gap-4",
            group === "capture"
              ? "mt-4 min-h-[22rem] flex-1 lg:mt-0 lg:min-h-0 short:min-h-0"
              : cn("gap-6 lg:mt-0", group === "ready" ? "mt-4" : "mt-8"),
          )}
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
              unsentRecordings={unsentRecordings}
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
        </section>
        {/* The page's own bottom edge, so a docked action stays in reach over the whole setup, however long its
            form; inside main (it is the page's action), over main's side and bottom padding. Only in setup: empty,
            it would let a recording scroll. On a short screen it stays at the page's end instead of covering it. */}
        {group === "setup" && <div ref={setDockSlot} className="sticky bottom-0 -mx-4 mt-12 -mb-12 md:hidden short:static" />}
      </main>
    </div>
  );
}

/** Recording: the focused recorder (Spela in) or the document sheet (Strömma), above the bar, which never moves. */
function CaptureWorkspace({ input, speakers, makesText }: { input: Session; speakers: boolean; makesText: boolean }) {
  const { session, snapshot, capture, persistent } = input;
  const { phase, problem, live, mode } = snapshot;
  const streaming = mode === "stromma" && live !== null;
  const silent = useSilence(capture.stream, phase === "recording");
  const [wakeLock, setWakeLock] = useState(true);
  useEffect(() => setWakeLock("wakeLock" in navigator), []);
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
          storageNote={persistent ? storageLine(true) : null}
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
  unsentRecordings,
}: {
  contract: RunContract;
  input: Session;
  /** On a phone: the page's bottom edge, where the primary action docks. */
  dock: HTMLElement | null;
  earlierRuns: EarlierRunsSnapshot;
  onOpenRun: (runId: string) => void;
  onMoreRuns: () => void;
  unsentRecordings: UnsentRecording[];
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
  const Icon = mode === "ladda-upp" && (file || optionalFile) ? FileText : mode ? MODE_TEXT[mode].icon : null;
  const reviewsSpeakers = speakerMappingReviewSteps(contract).length > 0;
  const text = makesText(contract.final_output);
  const create = createActionLabel(text);
  // The session refuses the setup's actions while the count is no count; its field takes the focus to put it right.
  const countInvalid = readSpeakerCount(snapshot.speakerCount) === "invalid";
  const focusCount = () => document.getElementById(SPEAKER_COUNT_ID)?.focus();
  const onContinue = modes.includes("spela-in")
    ? (recording: StoredRecording) => (countInvalid ? focusCount() : void session.continueCutOff(recording))
    : undefined;
  // A meeting a reload cut off goes on with its own "Fortsätt spela in", the one filled action meanwhile.
  const resuming = onContinue !== undefined && resumableRecording(unsentRecordings) !== undefined;
  const label =
    !mode || (mode === "ladda-upp" && optionalFile)
      ? create
      : !audio && !file
        ? "Välj fil"
        : primaryActionLabel(mode, file != null, text);

  function primary() {
    if (countInvalid) focusCount();
    else if (recordingMode) void session.start();
    else if (mode === "ladda-upp" && !file && !optionalFile) fileInput.current?.click();
    else void createDocument(session);
  }

  const speakerChoice =
    speakerOption?.selectable && snapshot.speakerLabels !== null ? (
      <Field orientation="horizontal" className="min-h-11 gap-4 has-[>[data-slot=field-content]]:items-center">
        <FieldContent className="gap-0.5">
          <FieldLabel htmlFor="talare" className="text-[17px] font-semibold text-ink">
            Märk upp talare
          </FieldLabel>
          <FieldDescription id="talare-hjalp" className="text-[15px]">
            Tar längre tid efter inspelningen.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="talare"
          checked={snapshot.speakerLabels}
          onCheckedChange={(on) => session.setSpeakerLabels(on)}
          aria-describedby="talare-hjalp"
          // A finger's hit area is 44 px tall: 12 px above and below the switch's padding box, over its own 10.
          className="coarse:after:-inset-y-3"
        />
      </Field>
    ) : speakerOption?.required || reviewsSpeakers ? (
      <p className="text-[15px] text-ink-soft">
        Flödet märker upp talare.
        {reviewsSpeakers && " Efter transkriberingen bekräftar du vem som är vem."}
      </p>
    ) : null;

  return (
    <div className="flex w-full flex-col gap-6">
      <UnsentRecordings
        recordings={unsentRecordings}
        sendLabel={() => create}
        onSend={(recording) => {
          if (countInvalid) return focusCount();
          session.adopt(recording);
          void createDocument(session);
        }}
        onContinue={onContinue}
      />

      {modes.length > 1 ? (
        <ModeCards modes={modes} mode={mode} onSelect={(next) => session.selectMode(next)} />
      ) : (
        // No choice to ask about: the setup is named by its one way (or by what it makes), so focus has a place to go.
        <h2 data-phase-heading tabIndex={-1} className="sr-only">
          {modes[0] ? MODE_TEXT[modes[0]].name : create}
        </h2>
      )}

      {/* The count belongs with the speaker choice, so the two stand closer than the setup's other parts. */}
      {(speakerChoice || snapshot.speakerCount !== null) && (
        <div className="flex flex-col gap-4">
          {speakerChoice}
          {snapshot.speakerCount !== null && (
            <SpeakerCountField
              value={snapshot.speakerCount}
              fromNames={snapshot.speakerCountFromNames}
              onChange={(text) => session.setSpeakerCount(text)}
            />
          )}
        </div>
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

      {problem && <ProblemAlert problem={problem} onRetry={() => void session.start()} />}

      {(mode || modes.length === 0) &&
        docked(
          dock,
          <div
            data-docked-action={dock ? true : undefined}
            className={cn(
              "flex flex-col",
              // On a phone the one primary action stays in reach at the page's bottom, above the safe area.
              dock
                ? "gap-2 border-t border-border bg-background px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3"
                : "gap-3",
            )}
          >
            <Button
              type="button"
              variant={resuming ? "outline" : "default"}
              size="xl"
              className="w-full"
              // Not disabled: that would drop keyboard focus while the browser asks for the microphone.
              aria-disabled={phase === "starting" || checkingUpload || undefined}
              onClick={primary}
            >
              {phase === "starting" || checkingUpload ? (
                <Spinner data-icon="inline-start" aria-hidden />
              ) : Icon ? (
                <Icon data-icon="inline-start" aria-hidden />
              ) : null}
              {phase === "starting" ? "Startar…" : checkingUpload ? "Kontrollerar filen…" : label}
            </Button>
            {/* The wait for a chosen file's length is said, not only written on the button. */}
            <p role="status" className="sr-only">
              {checkingUpload ? "Kontrollerar filen…" : ""}
            </p>
            {recordingMode && <p className="text-center text-[13px] text-ink-mute">{storageLine(persistent)}</p>}
          </div>,
        )}

      <EarlierRuns list={earlierRuns} onOpen={onOpenRun} onMore={onMoreRuns} className="pt-4" />
    </div>
  );
}
