"use client";

import { ChevronDown, FileText } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { BackToFlows } from "@/components/flow/BackToFlows";
import { ClassificationNote } from "@/components/flow/ClassificationNote";
import { createDocument, DetailsForm } from "@/components/flow/DetailsForm";
import { EarlierRuns } from "@/components/flow/EarlierRuns";
import { FlowTopBar } from "@/components/flow/FlowTopBar";
import { FRAME } from "@/components/frame";
import { MicrophoneCheck } from "@/components/flow/MicrophoneCheck";
import { MODE_TEXT, ModeCards } from "@/components/flow/ModeCards";
import { ProblemAlert } from "@/components/flow/ProblemAlert";
import { ReadyPanel } from "@/components/flow/ReadyPanel";
import { LiveSheet } from "@/components/flow/LiveSheet";
import { FocusedRecorder, RecordingBar } from "@/components/flow/Recorder";
import { useDocumentTitle, useElapsed, useLeaveGuard, useSilence } from "@/components/flow/recording-hooks";
import { UploadPanel } from "@/components/flow/UploadPanel";
import type { useFlowSession } from "@/components/flow/useFlowSession";
import { OfflineBanner } from "@/components/OfflineBanner";
import { UnsentRecordings, type UnsentRecording } from "@/components/UnsentRecordings";
import { speakerMappingReviewSteps, type FlowPublished, type RunContract } from "@/lib/api";
import type { EarlierRunsSnapshot } from "@/lib/earlier-runs";
import { browserStorage, primaryActionLabel, storageLine, type SessionPhase } from "@/lib/flow-session";
import { recentNames, rememberNames } from "@/lib/participants";
import type { StoredRecording } from "@/lib/recording-store";
import {
  detailsSummary,
  keepDetailsOpen,
  leaveWarning,
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
  useDocumentTitle(pageTitle(phase, elapsed, flowName));
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

  useEffect(() => setSuggestions(recentNames(browserStorage(), ownerId)), [ownerId]);

  useEffect(() => {
    if (shownGroup.current === group) return;
    shownGroup.current = group;
    workspace.current?.querySelector<HTMLElement>("[data-phase-heading]")?.focus();
  }, [group]);

  // Leaving while audio is held asks first, in the page's own dialog; beforeunload keeps the browser's.
  const router = useRouter();
  const [leave, setLeave] = useState<(() => void) | null>(null);
  // The question has no trigger of its own: focus goes back to where it was.
  const returnFocus = useRef<HTMLElement | null>(null);
  const ask = (goOn: () => void) => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setLeave(() => goOn);
  };
  useLeaveGuard(holdsAudio, ask);
  const onLeave = (event: MouseEvent) => {
    if (!holdsAudio) return;
    event.preventDefault();
    ask(() => router.push("/flows"));
  };

  const details = (
    <DetailsForm
      fields={fields}
      details={snapshot.details}
      invalid={snapshot.invalid}
      onChange={(name, value) => session.setDetail(name, value)}
      suggestions={suggestions}
      onNamesAdded={(names) => rememberNames(browserStorage(), ownerId, names)}
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
              {MODE_TEXT[mode].name}
            </Badge>
          ) : undefined
        }
      />
      <AlertDialog open={leave !== null} onOpenChange={(open) => !open && setLeave(null)}>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Lämna sidan?</AlertDialogTitle>
            <AlertDialogDescription>{leaveWarning(input.persistent, phase)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stanna kvar</AlertDialogCancel>
            <AlertDialogAction onClick={() => leave?.()}>
              Lämna sidan
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* Recording state changes are said once here; the timer never is. */}
      <p role="status" className="sr-only">
        {recordingAnnouncement(phase)}
      </p>
      <main
        id="innehall"
        className={cn(
          FRAME,
          "flex-1 pt-3",
          "lg:grid lg:grid-cols-[20rem_minmax(0,1fr)] lg:gap-10 lg:pt-8",
          group === "capture"
            ? "flex min-h-0 flex-col overflow-y-auto lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden lg:pb-6"
            : "pb-12 lg:items-start",
        )}
      >
        <div className={cn("flex flex-col gap-5", group === "capture" && "lg:min-h-0 lg:overflow-y-auto lg:pb-2")}>
          <BackToFlows onLeave={onLeave} className="hidden lg:inline-flex" />
          <h1 className="hidden text-[26px] font-semibold leading-tight tracking-[-0.02em] text-ink [text-wrap:balance] lg:block">
            {published.name}
          </h1>
          <div className={cn("flex flex-col gap-5", holdsAudio && "hidden lg:flex")}>
            {published.description && (
              <p className="max-w-prose text-[17px] leading-relaxed text-ink-soft">{published.description}</p>
            )}
            <ClassificationNote classification={contract.security_classification} />
          </div>
          {holdsAudio && fields.length > 0 ? (
            // While recording and after, the details fold into one line on a phone or tablet.
            <Collapsible open={openDetails} onOpenChange={setDetailsOpen}>
              <CollapsibleTrigger className="group flex min-h-12 w-full items-center gap-3 rounded-xl border border-rule-soft bg-paper px-4 text-left text-[15px] text-ink transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary lg:hidden">
                <span className="min-w-0 flex-1 truncate">{detailsSummary(fields, snapshot.details)}</span>
                <ChevronDown
                  aria-hidden
                  className="size-5 shrink-0 text-ink-soft transition-transform duration-150 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
                />
              </CollapsibleTrigger>
              <CollapsibleContent forceMount className="pt-4 data-[state=closed]:max-lg:hidden lg:pt-0">
                {details}
              </CollapsibleContent>
            </Collapsible>
          ) : (
            details
          )}
        </div>

        <section
          ref={workspace}
          aria-label="Ljudet"
          className={cn(
            "flex min-w-0 flex-col gap-4",
            group === "capture"
              ? "mt-4 min-h-[22rem] flex-1 lg:mt-0 lg:min-h-0"
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
              onCreate={() => void createDocument(session)}
              onContinue={input.continueStopped}
              onDiscard={() => void session.discard()}
              earlierRuns={earlierRuns}
              onOpenRun={onOpenRun}
              onMoreRuns={onMoreRuns}
            />
          ) : (
            <CaptureWorkspace input={input} />
          )}
        </section>
      </main>
      {/* The page's own bottom edge, so a docked action stays in reach over the whole setup, however long its form. */}
      <div ref={setDockSlot} className="sticky bottom-0 md:hidden" />
    </div>
  );
}

/** Recording: the focused recorder (Spela in) or the document sheet (Strömma), above the bar, which never moves. */
function CaptureWorkspace({ input }: { input: Session }) {
  const { session, snapshot, capture, persistent } = input;
  const { phase, problem, live, mode } = snapshot;
  const streaming = mode === "stromma" && live !== null;
  const silent = useSilence(capture.stream, phase === "recording");
  const [wakeLock, setWakeLock] = useState(true);
  useEffect(() => setWakeLock("wakeLock" in navigator), []);
  const notices = recordingNotices({
    phase,
    silent,
    lowSpace: capture.lowSpace,
    persistent: persistent !== false,
    wakeLock,
  });
  return (
    <>
      {problem && <ProblemAlert problem={problem} onRetry={() => void session.continueRecording()} />}
      {streaming ? (
        <LiveSheet live={live} recorder={capture.status} />
      ) : (
        <FocusedRecorder
          capture={session.capture}
          phase={phase}
          stream={capture.stream}
          storageNote={persistent ? storageLine(true) : null}
        />
      )}
      <RecordingBar
        capture={session.capture}
        phase={phase}
        stream={capture.stream}
        showStatus={streaming}
        notices={notices}
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
  const { modes, mode, phase, problem, file } = snapshot;
  const speakerOption = contract.transcription?.speaker_labels;
  const recordingMode = mode === "spela-in" || mode === "stromma";
  const fileInput = useRef<HTMLInputElement>(null);
  const step = selectRuntimeInputStep(contract);
  const audio = step?.input_format?.toLowerCase() === "audio";
  const reviewsSpeakers = speakerMappingReviewSteps(contract).length > 0;
  const Icon = mode === "ladda-upp" && file ? FileText : mode ? MODE_TEXT[mode].icon : null;
  const label =
    !mode ? "Skapa dokument" : !audio && !file ? "Välj fil" : primaryActionLabel(mode, file != null);

  function primary() {
    if (recordingMode) void session.start();
    else if (mode === "ladda-upp" && !file) fileInput.current?.click();
    else void createDocument(session);
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <UnsentRecordings
        recordings={unsentRecordings}
        onSend={(recording) => {
          session.adopt(recording);
          void createDocument(session);
        }}
        onContinue={modes.includes("spela-in") ? (recording) => void session.continueCutOff(recording) : undefined}
      />

      {modes.length > 1 && <ModeCards modes={modes} mode={mode} onSelect={(next) => session.selectMode(next)} />}

      {speakerOption?.selectable && snapshot.speakerLabels !== null ? (
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
          />
        </Field>
      ) : speakerOption?.required || reviewsSpeakers ? (
        <p className="text-[15px] text-ink-soft">
          Flödet märker upp talare.
          {reviewsSpeakers && " Efter transkriberingen bekräftar du vem som är vem."}
        </p>
      ) : null}

      {recordingMode && <MicrophoneCheck active={phase === "setup"} />}

      {mode === "ladda-upp" && (
        <UploadPanel
          step={step}
          file={file}
          audio={audio}
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
              size="xl"
              className="w-full"
              // Not disabled: that would drop keyboard focus while the browser asks for the microphone.
              aria-disabled={phase === "starting" || undefined}
              onClick={primary}
            >
              {phase === "starting" ? (
                <Spinner data-icon="inline-start" aria-hidden />
              ) : Icon ? (
                <Icon data-icon="inline-start" aria-hidden />
              ) : null}
              {phase === "starting" ? "Startar…" : label}
            </Button>
            {recordingMode && <p className="text-center text-[13px] text-ink-mute">{storageLine(persistent)}</p>}
          </div>,
        )}

      <EarlierRuns list={earlierRuns} onOpen={onOpenRun} onMore={onMoreRuns} className="pt-4" />
    </div>
  );
}
