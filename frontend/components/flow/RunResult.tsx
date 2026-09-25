"use client";

import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Mic, Pause, Play, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BackToFlows } from "@/components/flow/BackToFlows";
import { FRAME, READING } from "@/components/frame";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { inputFileAudioUrl, type FlowRunPublic, type FlowRunStep, type RunContract } from "@/lib/api";
import { formatClock, formatRelativeDate } from "@/lib/format";
import type { Playback } from "@/lib/playback";
import { fileText, transcriptFileName, type ResultFileView } from "@/lib/run-files";
import type { StepView } from "@/lib/run-progress";
import { outputWords, resultFileIds, runOutput, runResultView } from "@/lib/run-result";
import { cn } from "@/lib/utils";
import { ResultDocument } from "./ResultDocument";
import { regenerationOffer } from "@/lib/regenerate";
import { RegenerateNotice } from "./RegenerateNotice";
import { ResultFiles } from "./ResultFiles";
import { RunTranscriptView, useRunTranscript } from "./RunTranscript";
import { StepDetails } from "./StepDetails";
import { usePlayback, usePlaybackState } from "./AudioPlayer";
import { PHASE_HEADING, usePhaseHeading } from "./usePhaseHeading";

// From a laptop's width the document and the transcript sit side by side; narrower, they are two tabs.
const WIDE = "(min-width: 1024px)";
const subscribeWide = (onChange: () => void) => {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
const isWide = () => window.matchMedia(WIDE).matches;

type View = "document" | "transcript";
/**
 * No panel is a tab stop of its own (Radix makes each one): a panel is taller than the screen, so its focus could not
 * be seen, and each starts with its own controls. Side by side a panel is a plain column, without the role and name.
 */
const PANEL = { tabIndex: undefined } as const;
const COLUMN = { ...PANEL, role: undefined, "aria-labelledby": undefined } as const;

/**
 * A finished run: what the flow produced comes first, as a readable page with
 * its file and one filled action; the transcript sits beside it from a laptop's
 * width, and starting over is a quiet action in the header.
 */
export function RunResult({
  flowId,
  flowName,
  run,
  steps,
  stepResults,
  files,
  showTranscript = true,
  audio = true,
  onNewRecording,
  onRegenerated,
  contract = null,
}: {
  flowId: string;
  flowName: string;
  run: FlowRunPublic;
  steps: readonly StepView[];
  /** The step results, read once when the run ended. */
  stepResults: readonly FlowRunStep[];
  files: readonly ResultFileView[];
  showTranscript?: boolean;
  /** The flow takes audio, so a new run starts with a new recording. */
  audio?: boolean;
  onNewRecording: () => void;
  /** A new run was started from the reviewed transcript; the page follows it. */
  onRegenerated: (run: FlowRunPublic) => void;
  /** The flow's run contract: what a run of its version without a result makes (`runOutput`). */
  contract?: RunContract | null;
}) {
  const delivered = run.result?.kind === "outbound_http";
  const words = outputWords(runOutput(run, contract));
  const heading = usePhaseHeading(`Klart · ${flowName}`);
  const { text, note } = runResultView(run.result);
  const finished = run.finished_at ?? run.created_at;
  // The document's file is the result's own (Eneo's run.result, not any step's file) that can be fetched; any other
  // run files are listed under it.
  const resultIds = resultFileIds(run.result);
  const primary = files.find((file) => file.available && resultIds.includes(file.fileId)) ?? null;
  const others = files.filter((file) => file !== primary);
  // A document that is only its file shows what the file says under it.
  const preview = !text && primary ? fileText(primary, stepResults) : null;
  const { transcript, confirmedWords, editing, reload } = useRunTranscript(flowId, run.id, stepResults, showTranscript);
  const offer =
    // Whether the document is older than the saved corrections does not depend on the latest save.
    showTranscript && !delivered
      ? regenerationOffer({
          flowId,
          run,
          stepId: transcript.stepId,
          fromMetadata: transcript.fromMetadata,
          corrections: editing.corrections,
          hasDocument: Boolean(text || files.length),
        })
      : null;
  // A document Eneo made again from a reviewed transcript says so; it is not a sign that anyone checked it.
  const fromReviewed = Boolean((run.input_payload_json as { transcript_regeneration?: unknown } | null | undefined)?.transcript_regeneration);
  const wide = useSyncExternalStore(subscribeWide, isWide, () => true);
  // One playback for the page: the transcript's player, and the pause beside the document on a phone.
  const sources = useMemo(
    () => transcript.fileIds.map((id) => ({ url: inputFileAudioUrl(flowId, run.id, id), durationMs: null })),
    [flowId, run.id, transcript.fileIds],
  );
  const playback = usePlayback(sources);
  const tabs = !wide && showTranscript;
  const [view, setView] = useState<View>("document");
  const tabList = useRef<HTMLDivElement | null>(null);
  // Each tab keeps its own reading position; the first visit starts at the top of the tab.
  const positions = useRef<Partial<Record<View, number>>>({});
  const switchView = (next: View) => {
    positions.current[view] = window.scrollY;
    setView(next);
  };
  useLayoutEffect(() => {
    if (!tabs) return;
    const top = (tabList.current?.getBoundingClientRect().top ?? 0) + window.scrollY - 8;
    const saved = positions.current[view];
    window.scrollTo({ top: saved ?? Math.min(window.scrollY, top) });
  }, [view, tabs]);

  const documentColumn = (
    <>
      {note && <p className="text-[15px] leading-relaxed">{note}</p>}
      {offer && (
        <RegenerateNotice offer={offer} saveState={editing.saveState} onStarted={onRegenerated} onReload={reload} thing={words.thing} />
      )}
      {(text || primary) && <ResultDocument flowId={flowId} runId={run.id} text={text} file={primary} title={flowName} preview={preview} label={words.named} />}
      {others.length > 0 && (
        <ResultFiles flowId={flowId} runId={run.id} files={others} title={primary ? "Fler filer" : "Filer"} />
      )}
      <StepDetails steps={steps} version={run.flow_version} />
    </>
  );
  const transcriptColumn = showTranscript && (
    <RunTranscriptView
      flowId={flowId}
      runId={run.id}
      fileName={transcriptFileName(flowName, run.created_at)}
      transcript={transcript}
      confirmedWords={confirmedWords}
      editing={editing}
      onReload={reload}
      playback={playback}
    />
  );

  return (
    // The frame owns the width: the workspace for the document and its transcript, a reading column for a document alone.
    <main id="innehall" className={cn(FRAME, "flex flex-1 flex-col pb-12 pt-2 lg:pt-8")}>
      <div className={cn("flex flex-col gap-6", !showTranscript && READING)}>
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 ref={heading} tabIndex={-1} className={PHASE_HEADING}>
            {delivered ? "Resultatet är skickat" : words.ready}
          </h1>
          {finished && (
            <p className="text-[14px] text-muted-foreground">
              {/* On a phone the top bar already names the flow. */}
              <span className="hidden lg:inline">{flowName} · </span>
              Skapad {formatRelativeDate(finished)}
              {fromReviewed && " från det rättade transkriptet"}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" variant="outline" onClick={onNewRecording}>
            {audio ? <Mic data-icon="inline-start" aria-hidden /> : <Plus data-icon="inline-start" aria-hidden />}
            {audio ? "Ny inspelning" : "Ny körning"}
          </Button>
          <BackToFlows size="default" className="hidden lg:inline-flex" />
        </div>
      </header>

      {/* One tree for every width, so the transcript (and a correction being written in it) stays mounted when the
          window crosses the laptop breakpoint: tabs below it, the same two panels side by side from it. */}
      <Tabs
        value={view}
        onValueChange={(next) => switchView(next as View)}
        className={cn(
          "flex flex-col gap-4",
          showTranscript && "lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,6fr)] lg:items-start lg:gap-x-8",
        )}
      >
        {tabs && (
          <TabsList ref={tabList} aria-label="Visa" className="self-start">
            <TabsTrigger value="document">{words.tab}</TabsTrigger>
            <TabsTrigger value="transcript">Transkript</TabsTrigger>
          </TabsList>
        )}
        {/* Both stay mounted: switching keeps the playback, the search, the filter and each tab's place. Side by
            side they are plain columns, not tab panels. */}
        <TabsContent
          value="document"
          forceMount
          {...(tabs ? PANEL : COLUMN)}
          className={cn("mt-0 flex min-w-0 flex-col gap-6", tabs && "data-[state=inactive]:hidden")}
        >
          {documentColumn}
          {tabs && <PausePlayback playback={playback} onShow={() => switchView("transcript")} />}
        </TabsContent>
        {transcriptColumn && (
          <TabsContent
            value="transcript"
            forceMount
            {...(tabs ? PANEL : COLUMN)}
            className={cn("mt-0 min-w-0", tabs ? "data-[state=inactive]:hidden" : "lg:sticky lg:top-6")}
          >
            {transcriptColumn}
          </TabsContent>
        )}
      </Tabs>
      </div>
    </main>
  );
}

/**
 * On a phone's Dokument tab, once the recording has played: its pause (or play)
 * and time, docked at the bottom, driven by the transcript's player itself.
 */
function PausePlayback({ playback, onShow }: { playback: Playback; onShow: () => void }): ReactNode {
  const state = usePlaybackState(playback);
  if (!state.started) return null;
  const pauses = state.playing || state.starting;
  return (
    <div
      data-docked-player
      className="sticky bottom-0 z-10 -mx-4 flex items-center gap-3 border-t border-border bg-card px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:-mx-8 md:px-8 short:static"
    >
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="shrink-0 rounded-full"
        aria-label={pauses ? "Pausa uppspelningen" : "Spela upp"}
        onClick={() => playback.toggle()}
      >
        {pauses ? <Pause aria-hidden /> : <Play aria-hidden className="translate-x-px" />}
      </Button>
      <span className="text-[14px] tabular-nums text-ink-soft">
        {formatClock(state.atMs)} / {formatClock(state.totalMs)}
      </span>
      <Button type="button" variant="link" className="ml-auto px-0" onClick={onShow}>
        Visa i transkriptet
      </Button>
    </div>
  );
}
