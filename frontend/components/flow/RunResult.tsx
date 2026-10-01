"use client";

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Mic, Pause, Play, Plus } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { BackToFlows } from "@/components/flow/BackToFlows";
import { inputFileAudioUrl, type FlowRunPublic, type FlowRunStep, type RunContract } from "@/lib/api";
import { formatClock, formatRelativeDate } from "@/lib/format";
import type { Playback } from "@/lib/playback";
import { fileText, transcriptFileName, type ResultFileView } from "@/lib/run-files";
import type { StepView } from "@/lib/run-progress";
import { outputWords, resultFileIds, runOutput, runResultView } from "@/lib/run-result";
import { ResultDocument } from "./ResultDocument";
import { regenerationOffer } from "@/lib/regenerate";
import { RegenerateNotice } from "./RegenerateNotice";
import { LAPTOP, ResultFiles, useMediaMatch } from "./ResultFiles";
import { RunTranscriptView, useRunTranscript } from "./RunTranscript";
import { StepDetails } from "./StepDetails";
import { usePlayback, usePlaybackState } from "./AudioPlayer";
import styles from "./RunResult.module.css";
import { usePhaseHeading } from "./usePhaseHeading";

type View = "document" | "transcript";
const PANELS: Record<View, { tab: string; panel: string }> = {
  document: { tab: "result-tab-document", panel: "result-panel-document" },
  transcript: { tab: "result-tab-transcript", panel: "result-panel-transcript" },
};

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
  const wide = useMediaMatch(LAPTOP);
  // One playback for the page: the transcript's player, and the pause beside the document on a phone.
  const sources = useMemo(
    () => transcript.fileIds.map((id) => ({ url: inputFileAudioUrl(flowId, run.id, id), durationMs: null })),
    [flowId, run.id, transcript.fileIds],
  );
  const playback = usePlayback(sources);
  const tabs = !wide && showTranscript;
  const [view, setView] = useState<View>("document");
  const tabList = useRef<HTMLElement | null>(null);
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
      {note && <Text as="p">{note}</Text>}
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
  // Both panels stay mounted: switching keeps the playback, the search, the filter and each tab's place. Side by side
  // they are plain columns, not tab panels. A panel is a plain element, not a stack: a stack's display would beat the
  // hidden attribute that hides the panel of the tab not chosen.
  const panel = (view_: View, isChosen: boolean, content: ReactNode, className?: string) => (
    <section
      id={PANELS[view_].panel}
      role={tabs ? "tabpanel" : undefined}
      aria-labelledby={tabs ? PANELS[view_].tab : undefined}
      hidden={tabs && !isChosen}
      className={className}
    >
      {content}
    </section>
  );

  return (
    // The frame gives the page its width and edges; a document alone is a reading column on its left edge.
    <VStack gap={6} paddingBlockStart={2} maxWidth={showTranscript ? undefined : 672}>
      <HStack hAlign="between" vAlign="end" wrap="wrap" gap={3}>
        <VStack gap={1}>
          <Heading level={1} ref={heading} tabIndex={-1}>
            {delivered ? "Resultatet är skickat" : words.ready}
          </Heading>
          {finished && (
            <Text as="p" type="supporting">
              {/* On a phone the top bar already names the flow. */}
              {wide && `${flowName} · `}
              Skapad {formatRelativeDate(finished)}
              {fromReviewed && " från det rättade transkriptet"}
            </Text>
          )}
        </VStack>
        <HStack vAlign="center" gap={2}>
          <Button icon={<Icon icon={audio ? Mic : Plus} />} label={audio ? "Ny inspelning" : "Ny körning"} onClick={onNewRecording} />
          {wide && <BackToFlows size="default" />}
        </HStack>
      </HStack>

      {/* One tree for every width, so the transcript (and a correction being written in it) stays mounted when the
          window crosses the laptop breakpoint: tabs below it, the same two panels side by side from it. */}
      <VStack gap={4} className={showTranscript && wide ? styles.sideBySide : undefined}>
        {tabs && (
          <TabList ref={tabList} role="tablist" aria-label="Visa" value={view} onChange={(next) => switchView(next as View)}>
            <Tab value="document" id={PANELS.document.tab} panelId={PANELS.document.panel} label={words.tab} />
            <Tab value="transcript" id={PANELS.transcript.tab} panelId={PANELS.transcript.panel} label="Transkript" />
          </TabList>
        )}
        {panel(
          "document",
          view === "document",
          <VStack gap={6}>
            {documentColumn}
            {tabs && <PausePlayback playback={playback} onShow={() => switchView("transcript")} />}
          </VStack>,
        )}
        {transcriptColumn && panel("transcript", view === "transcript", transcriptColumn, tabs ? undefined : styles.sticky)}
      </VStack>
    </VStack>
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
    <HStack data-docked-player className={styles.docked} vAlign="center" gap={3}>
      <Button
        isIconOnly
        icon={<Icon icon={pauses ? Pause : Play} />}
        label={pauses ? "Pausa uppspelningen" : "Spela upp"}
        onClick={() => playback.toggle()}
      />
      <Text type="supporting" hasTabularNumbers>
        {formatClock(state.atMs)} / {formatClock(state.totalMs)}
      </Text>
      <Button variant="ghost" label="Visa i transkriptet" onClick={onShow} />
    </HStack>
  );
}
