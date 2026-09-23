"use client";

import { ArrowLeft, ChevronDown, FileText, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { createDocument, DetailsForm } from "@/components/flow/DetailsForm";
import { FlowTopBar } from "@/components/flow/FlowTopBar";
import { MicrophoneCheck } from "@/components/flow/MicrophoneCheck";
import { MODE_TEXT, ModeCards } from "@/components/flow/ModeCards";
import { ProblemAlert } from "@/components/flow/ProblemAlert";
import { ReadyPanel } from "@/components/flow/ReadyPanel";
import { FocusedRecorder, RecordingBar } from "@/components/flow/Recorder";
import { useDocumentTitle, useElapsed, useLeaveGuard, useSilence } from "@/components/flow/recording-hooks";
import { UploadPanel } from "@/components/flow/UploadPanel";
import type { useFlowSession } from "@/components/flow/useFlowSession";
import { OfflineBanner } from "@/components/OfflineBanner";
import { UnsentRecordings } from "@/components/UnsentRecordings";
import { speakerMappingReviewSteps, type FlowPublished, type FlowRunSummary, type RunContract } from "@/lib/api";
import { browserStorage, primaryActionLabel, storageLine, type SessionPhase } from "@/lib/flow-session";
import { formatRelativeDate } from "@/lib/format";
import { recentNames, rememberNames } from "@/lib/participants";
import type { StoredRecording } from "@/lib/recording-store";
import { detailsSummary, pageTitle, recordingAnnouncement, recordingNotices } from "@/lib/recording-view";
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

// One message for recording and ready: true for both, so the guard never changes mid-way.
const LEAVE_MESSAGE = "Vill du lämna sidan? Det som spelats in finns kvar bland osända inspelningar.";

const RESUMABLE_LABEL: Record<string, string> = {
  awaiting_review: "Väntar på din granskning",
  queued: "Står i kö",
};

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
  resumableRuns,
  onResume,
  unsentRecordings,
}: {
  published: FlowPublished;
  contract: RunContract;
  input: Session;
  ownerId: string;
  /** A problem from following an earlier run. */
  notice: string | null;
  resumableRuns: FlowRunSummary[];
  onResume: (runId: string) => void;
  unsentRecordings: StoredRecording[];
}) {
  const { session, snapshot } = input;
  const { phase, mode } = snapshot;
  const group = PHASE_GROUP[phase];
  const holdsAudio = group !== "setup";
  const workspace = useRef<HTMLElement>(null);
  const shownGroup = useRef(group);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const fields = contract.form_fields ?? [];

  useEffect(() => setSuggestions(recentNames(browserStorage(), ownerId)), [ownerId]);

  useEffect(() => {
    if (shownGroup.current === group) return;
    shownGroup.current = group;
    workspace.current?.querySelector<HTMLElement>("[data-phase-heading]")?.focus();
  }, [group]);

  useLeaveGuard(holdsAudio ? LEAVE_MESSAGE : null);
  const onLeave = (event: MouseEvent) => {
    if (holdsAudio && !window.confirm(LEAVE_MESSAGE)) event.preventDefault();
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
      {/* Recording state changes are said once here; the timer never is. */}
      <p role="status" className="sr-only">
        {recordingAnnouncement(phase)}
      </p>
      <main
        id="innehall"
        className={cn(
          "w-full flex-1 px-4 pt-3 md:px-8",
          "lg:grid lg:grid-cols-[20rem_minmax(0,1fr)] lg:gap-10 lg:pt-8",
          group === "capture"
            ? "flex min-h-0 flex-col overflow-y-auto lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden lg:pb-6"
            : "pb-12 lg:items-start",
        )}
      >
        <div className={cn("flex flex-col gap-5", group === "capture" && "lg:min-h-0 lg:overflow-y-auto lg:pb-2")}>
          <Link
            href="/flows"
            onClick={onLeave}
            className="hidden w-fit items-center gap-2 rounded-md text-[15px] font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary lg:inline-flex"
          >
            <ArrowLeft aria-hidden className="size-4" />
            Flöden
          </Link>
          <h1 className="hidden text-[26px] font-semibold leading-tight tracking-[-0.02em] text-ink [text-wrap:balance] lg:block">
            {published.name}
          </h1>
          <div className={cn("flex flex-col gap-5", holdsAudio && "hidden lg:flex")}>
            {published.description && (
              <p className="max-w-prose text-[17px] leading-relaxed text-ink-soft">{published.description}</p>
            )}
            <Alert role="note">
              <ShieldCheck aria-hidden />
              <AlertDescription className="text-[15px] text-ink">
                Öppen information. Ladda inte upp personuppgifter.
              </AlertDescription>
            </Alert>
          </div>
          {holdsAudio && fields.length > 0 ? (
            // While recording and after, the details fold into one line on a phone or tablet.
            <Collapsible open={detailsOpen || snapshot.invalid.length > 0} onOpenChange={setDetailsOpen}>
              <CollapsibleTrigger className="group flex min-h-12 w-full items-center gap-3 rounded-xl border border-rule-soft bg-paper px-4 text-left text-[15px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary lg:hidden">
                <span className="min-w-0 flex-1 truncate">{detailsSummary(fields, snapshot.details)}</span>
                <ChevronDown
                  aria-hidden
                  className="size-5 shrink-0 text-ink-soft transition-transform duration-150 group-data-[state=open]:rotate-180"
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
              resumableRuns={resumableRuns}
              onResume={onResume}
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
            />
          ) : (
            <CaptureWorkspace input={input} />
          )}
        </section>
      </main>
    </div>
  );
}

/** Recording (Spela in): the focused recorder above the bar, which never moves. */
function CaptureWorkspace({ input }: { input: Session }) {
  const { session, snapshot, capture, persistent } = input;
  const { phase, problem } = snapshot;
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
      <FocusedRecorder
        capture={session.capture}
        phase={phase}
        stream={capture.stream}
        storageNote={persistent ? storageLine(true) : null}
      />
      <RecordingBar
        capture={session.capture}
        phase={phase}
        stream={capture.stream}
        showStatus={false}
        notices={notices}
        onPause={() => (phase === "interrupted" ? void session.continueRecording() : session.togglePause())}
        onStop={() => void session.stop()}
      />
    </>
  );
}

function SetupWorkspace({
  contract,
  input,
  resumableRuns,
  onResume,
  unsentRecordings,
}: {
  contract: RunContract;
  input: Session;
  resumableRuns: FlowRunSummary[];
  onResume: (runId: string) => void;
  unsentRecordings: StoredRecording[];
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
    <div className="flex w-full max-w-2xl flex-col gap-6">
      {resumableRuns.length > 0 && <ResumableRuns runs={resumableRuns} onResume={onResume} />}
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
        <>
          <input
            ref={fileInput}
            type="file"
            accept={step?.accepted_mimetypes?.join(",") || (audio ? "audio/*" : undefined)}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              if (chosen) session.chooseFile(chosen);
              event.target.value = "";
            }}
          />
          <UploadPanel
            step={step}
            file={file}
            audio={audio}
            onPick={() => fileInput.current?.click()}
            onDrop={(dropped) => session.chooseFile(dropped)}
          />
        </>
      )}

      {problem && <ProblemAlert problem={problem} onRetry={() => void session.start()} />}

      {(mode || modes.length === 0) && (
        <div className="flex flex-col gap-3">
          <Button
            type="button"
            size="lg"
            className="h-12 w-full rounded-xl px-6 text-[16px]"
            // Not disabled: that would drop keyboard focus while the browser asks for the microphone.
            aria-disabled={phase === "starting" || undefined}
            onClick={primary}
          >
            {phase === "starting" ? (
              <Spinner data-icon="inline-start" aria-hidden className="size-5" />
            ) : Icon ? (
              <Icon data-icon="inline-start" aria-hidden className="size-5" />
            ) : null}
            {phase === "starting" ? "Startar…" : label}
          </Button>
          {recordingMode && <p className="text-center text-[13px] text-ink-mute">{storageLine(persistent)}</p>}
        </div>
      )}
    </div>
  );
}

function ResumableRuns({ runs, onResume }: { runs: FlowRunSummary[]; onResume: (runId: string) => void }) {
  return (
    <section aria-labelledby="pagaende" className="rounded-xl border border-rule-soft bg-paper p-4">
      <h2 id="pagaende" className="text-[15px] font-semibold text-ink">
        {runs.length === 1 ? "En körning pågår för det här flödet" : `${runs.length} körningar pågår för det här flödet`}
      </h2>
      <ul className="mt-3 flex flex-col gap-2">
        {runs.map((run) => (
          <li key={run.id} className="flex items-center justify-between gap-3">
            <span className="text-[15px] text-ink-soft">
              {RESUMABLE_LABEL[run.status] ?? "Bearbetas"}
              {run.created_at && `, startad ${formatRelativeDate(run.created_at)}`}
            </span>
            <Button type="button" variant="outline" className="h-11" onClick={() => onResume(run.id)}>
              Följ körningen
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

