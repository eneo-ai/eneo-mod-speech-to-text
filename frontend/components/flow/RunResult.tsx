"use client";

import Link from "next/link";
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowLeft, Mic, Pause, Play, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { inputFileAudioUrl, type FlowRunPublic, type FlowRunStep } from "@/lib/api";
import { formatClock, formatRelativeDate } from "@/lib/format";
import type { Playback } from "@/lib/playback";
import { transcriptFileName, type ResultFileView } from "@/lib/run-files";
import type { StepView } from "@/lib/run-progress";
import { runResultView } from "@/lib/run-result";
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
}) {
  const delivered = run.result?.kind === "outbound_http";
  const heading = usePhaseHeading("Klart");
  const { text, note } = runResultView(run.result);
  const finished = run.finished_at ?? run.created_at;
  // The document's file is the first one that can be fetched; any others are listed under it.
  const primary = files.find((file) => file.available) ?? null;
  const others = files.filter((file) => file !== primary);
  const { transcript, confirmedWords, editing, reload } = useRunTranscript(flowId, run.id, stepResults, showTranscript);
  const offer =
    showTranscript && !delivered && editing.saveState !== "error"
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
        <RegenerateNotice offer={offer} saving={editing.saveState === "saving"} onStarted={onRegenerated} onReload={reload} />
      )}
      {(text || primary) && <ResultDocument flowId={flowId} runId={run.id} text={text} file={primary} title={flowName} />}
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
    <main
      className={cn(
        "mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 pb-12 pt-2 md:px-8 lg:pt-8",
        // The frame owns the page's width; from a laptop's width the result takes what it gives.
        showTranscript && "lg:max-w-none",
      )}
    >
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 ref={heading} tabIndex={-1} className={PHASE_HEADING}>
            {delivered ? "Resultatet är skickat" : "Dokumentet är klart"}
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
          <Button asChild variant="ghost" className="hidden lg:inline-flex">
            <Link href="/flows">
              <ArrowLeft data-icon="inline-start" aria-hidden />
              Till flödena
            </Link>
          </Button>
        </div>
      </header>

      {tabs ? (
        <Tabs value={view} onValueChange={(next) => switchView(next as View)} className="flex flex-col gap-4">
          <TabsList ref={tabList} aria-label="Visa" className="self-start">
            <TabsTrigger value="document">Dokument</TabsTrigger>
            <TabsTrigger value="transcript">Transkript</TabsTrigger>
          </TabsList>
          {/* Both stay mounted: switching keeps the playback, the search, the filter and each tab's place. */}
          <TabsContent value="document" forceMount className="mt-0 flex flex-col gap-6 data-[state=inactive]:hidden">
            {documentColumn}
            <PausePlayback playback={playback} onShow={() => switchView("transcript")} />
          </TabsContent>
          <TabsContent value="transcript" forceMount className="mt-0 data-[state=inactive]:hidden">
            {transcriptColumn}
          </TabsContent>
        </Tabs>
      ) : (
        <div
          className={cn(
            "flex flex-col gap-8",
            showTranscript && "lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,6fr)] lg:items-start lg:gap-x-8",
          )}
        >
          <div className="flex min-w-0 flex-col gap-6">{documentColumn}</div>
          {transcriptColumn && <div className="min-w-0 lg:sticky lg:top-6">{transcriptColumn}</div>}
        </div>
      )}
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
      className="sticky bottom-0 z-10 -mx-4 flex items-center gap-3 border-t border-border bg-card px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:-mx-8 md:px-8"
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
