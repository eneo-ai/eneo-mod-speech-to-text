"use client";

import { ArrowLeft, FileAudio, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { createDocument, DetailsForm } from "@/components/flow/DetailsForm";
import { FlowTopBar } from "@/components/flow/FlowTopBar";
import { MicrophoneCheck } from "@/components/flow/MicrophoneCheck";
import { MODE_TEXT, ModeCards } from "@/components/flow/ModeCards";
import { ProblemAlert } from "@/components/flow/ProblemAlert";
import type { useFlowSession } from "@/components/flow/useFlowSession";
import { OfflineBanner } from "@/components/OfflineBanner";
import { UnsentRecordings } from "@/components/UnsentRecordings";
import { speakerMappingReviewSteps, type FlowPublished, type FlowRunSummary, type RunContract } from "@/lib/api";
import { browserStorage, primaryActionLabel, storageLine, type SessionPhase } from "@/lib/flow-session";
import { formatRelativeDate } from "@/lib/format";
import { recentNames, rememberNames } from "@/lib/participants";
import type { StoredRecording } from "@/lib/recording-store";
import { formatBytes, selectRuntimeInputStep } from "@/lib/upload";

type Session = ReturnType<typeof useFlowSession>;

// Focus moves to the new state's heading when the page changes state, never within one.
const PHASE_GROUP: Record<SessionPhase, string> = {
  setup: "setup",
  starting: "setup",
  recording: "capture",
  paused: "capture",
  interrupted: "capture",
  ready: "ready",
};

const RESUMABLE_LABEL: Record<string, string> = {
  awaiting_review: "Väntar på din granskning",
  queued: "Står i kö",
};

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
  const { phase } = snapshot;
  const workspace = useRef<HTMLElement>(null);
  const group = useRef(PHASE_GROUP[phase]);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  useEffect(() => setSuggestions(recentNames(browserStorage(), ownerId)), [ownerId]);

  useEffect(() => {
    if (group.current === PHASE_GROUP[phase]) return;
    group.current = PHASE_GROUP[phase];
    workspace.current?.querySelector<HTMLElement>("[data-phase-heading]")?.focus();
  }, [phase]);

  return (
    <div className="flex min-h-dvh flex-col">
      <FlowTopBar title={published.name} />
      <main
        id="innehall"
        className="w-full flex-1 px-4 pb-12 pt-3 md:px-8 lg:grid lg:grid-cols-[20rem_minmax(0,1fr)] lg:items-start lg:gap-10 lg:pt-8"
      >
        <div className="flex flex-col gap-5">
          <Link
            href="/flows"
            className="hidden w-fit items-center gap-2 rounded-md text-[15px] font-medium text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent lg:inline-flex"
          >
            <ArrowLeft aria-hidden className="size-4" />
            Flöden
          </Link>
          <h1 className="hidden text-[26px] font-semibold leading-tight tracking-[-0.02em] text-ink [text-wrap:balance] lg:block">
            {published.name}
          </h1>
          {published.description && (
            <p className="max-w-prose text-[17px] leading-relaxed text-ink-soft">{published.description}</p>
          )}
          <Alert role="note">
            <ShieldCheck aria-hidden />
            <AlertDescription className="text-[15px] text-ink">
              Öppen information. Ladda inte upp personuppgifter.
            </AlertDescription>
          </Alert>
          <DetailsForm
            fields={contract.form_fields ?? []}
            details={snapshot.details}
            invalid={snapshot.invalid}
            onChange={(name, value) => session.setDetail(name, value)}
            suggestions={suggestions}
            onNamesAdded={(names) => rememberNames(browserStorage(), ownerId, names)}
          />
        </div>

        <section ref={workspace} aria-label="Ljudet" className="mt-8 flex min-w-0 flex-col gap-6 lg:mt-0">
          <OfflineBanner waiting={PHASE_GROUP[phase] === "capture" ? "recording" : null} />
          {notice && <ProblemAlert problem={{ title: notice }} />}
          {phase === "setup" || phase === "starting" ? (
            <SetupWorkspace
              contract={contract}
              input={input}
              resumableRuns={resumableRuns}
              onResume={onResume}
              unsentRecordings={unsentRecordings}
            />
          ) : phase === "ready" ? (
            <InterimReady input={input} />
          ) : (
            <InterimRecorder input={input} />
          )}
        </section>
      </main>
    </div>
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
  const Icon = mode ? MODE_TEXT[mode].icon : null;
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
          {file && (
            <div className="flex items-center gap-3 rounded-xl border border-rule-soft bg-paper p-4">
              <FileAudio aria-hidden className="size-6 shrink-0 text-accent" strokeWidth={1.75} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-medium text-ink">{file.filename}</p>
                <p className="text-[13px] text-ink-soft">{formatBytes(file.blob.size)}</p>
              </div>
              <Button type="button" variant="outline" className="h-11" onClick={() => fileInput.current?.click()}>
                Byt fil
              </Button>
            </div>
          )}
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

// Interim views; the recording and ready states replace them.
function InterimRecorder({ input }: { input: Session }): ReactNode {
  const { session, snapshot } = input;
  return (
    <div className="flex flex-col gap-4">
      <h2 data-phase-heading tabIndex={-1} className="text-[20px] font-semibold outline-none">
        {snapshot.phase === "recording" ? "Spelar in" : "Pausad"}
      </h2>
      <div className="flex gap-3">
        <Button type="button" variant="outline" className="h-11" onClick={() => session.togglePause()}>
          {snapshot.phase === "recording" ? "Pausa" : "Fortsätt"}
        </Button>
        <Button type="button" className="h-11" onClick={() => void session.stop()}>
          Stoppa
        </Button>
      </div>
    </div>
  );
}

function InterimReady({ input }: { input: Session }): ReactNode {
  const { session, snapshot } = input;
  return (
    <div className="flex flex-col gap-4">
      <h2 data-phase-heading tabIndex={-1} className="text-[20px] font-semibold outline-none">
        Inspelningen är klar
      </h2>
      {snapshot.problem && <ProblemAlert problem={snapshot.problem} />}
      <Button type="button" className="h-12 rounded-xl" onClick={() => void createDocument(session)}>
        Skapa dokument
      </Button>
    </div>
  );
}
