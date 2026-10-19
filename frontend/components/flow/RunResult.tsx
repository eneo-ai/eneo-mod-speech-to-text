import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Mic, Pause, Play, Plus } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Grid, GridSpan } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { inputFileAudioUrl, type FlowRunPublic, type FlowRunStep, type RunContract } from "@/lib/api";
import { savedSets, type SavedCorrections } from "@/lib/follow-run";
import { browserStorage } from "@/lib/browser-storage";
import { useDock } from "@/lib/dock";
import { formatClock, formatRelativeDate } from "@/lib/format";
import { detailRows, detailsSummary } from "@/lib/recording-view";
import type { Playback } from "@/lib/playback";
import { rememberPosition } from "@/lib/playback-position";
import { fileText, runFileName, transcriptFileName, type ResultFileView } from "@/lib/run-files";
import { ofContractVersion, type StepView } from "@/lib/run-progress";
import { outputWords, resultFileIds, runOutput, runResultView } from "@/lib/run-result";
import { ResultDocument } from "./ResultDocument";
import { useAuthenticatedUser } from "@/components/AuthGate";
import { hasNamesDraft } from "@/components/SpeakerNamingDialog";
import { correctionsNewerThanDocument, namesOnly, regenerationOffer, savedTranscriptCorrections } from "@/lib/regenerate";
import { RegenerateNotice } from "./RegenerateNotice";
import { LAPTOP, ResultFiles } from "./ResultFiles";
import { RunTranscriptView, useRunTranscript } from "./RunTranscript";
import { StepDetails } from "./StepDetails";
import { usePlayback, usePlaybackState } from "./AudioPlayer";
import styles from "./RunResult.module.css";
import { usePhaseHeading } from "./usePhaseHeading";
import { LeaveContext } from "./useLeaveQuestion";

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
  savedCorrections,
  files,
  showTranscript = true,
  audio = true,
  onNewRecording,
  onRegenerated,
  onStartAgain,
  contract = null,
}: {
  flowId: string;
  flowName: string;
  run: FlowRunPublic;
  steps: readonly StepView[];
  /** The step results, read once when the run ended. */
  stepResults: readonly FlowRunStep[];
  /** The transcript's saved corrections, as read with the run (readFinishedRun, SavedCorrections). */
  savedCorrections?: SavedCorrections;
  files: readonly ResultFileView[];
  showTranscript?: boolean;
  /** The flow takes audio, so a new run starts with a new recording. */
  audio?: boolean;
  onNewRecording: () => void;
  /** A new run was started from the reviewed transcript; the page follows it. */
  onRegenerated: (run: FlowRunPublic) => void;
  /** A new run with the same audio and details; absent when the run has no audio to start again with. */
  onStartAgain?: () => void;
  /** The flow's run contract: what a run of its version without a result makes (`runOutput`). */
  contract?: RunContract | null;
}) {
  const { leaveFirst } = useContext(LeaveContext);
  const delivered = run.result?.kind === "outbound_http";
  const words = outputWords(runOutput(run, contract));
  const { text: shown, note } = runResultView(run.result);
  // Blank text is no text, and a run with no file either has nothing to show: the page says that, not that it is ready.
  const text = shown?.trim() ? shown : null;
  const empty = !delivered && !text && files.length === 0;
  const heading = usePhaseHeading(empty ? `Resultatet är tomt · ${flowName}` : `Klart · ${flowName}`);
  const finished = run.finished_at ?? run.created_at;
  // The document's file is the result's own (Eneo's run.result, not any step's file) that can be fetched; any other
  // run files are listed under it.
  const resultIds = resultFileIds(run.result);
  const primary = files.find((file) => file.available && resultIds.includes(file.fileId)) ?? null;
  const others = files.filter((file) => file !== primary);
  // A document that is only its file shows what the file says under it.
  const preview = !text && primary ? fileText(primary, stepResults) : null;
  const { transcript, confirmedWords, editing, reload } = useRunTranscript(flowId, run.id, stepResults, showTranscript, savedCorrections);
  const hasDocument = Boolean(text || files.length);
  const offer =
    // Whether the document is older than the saved corrections does not depend on the latest save.
    showTranscript && !delivered
      ? regenerationOffer({
          flowId,
          run,
          stepId: transcript.stepId,
          fromMetadata: transcript.fromMetadata,
          corrections: editing.corrections,
          hasDocument,
        })
      : null;
  // Known from the run's own read, before the transcript is: the notice has its place from the first draw, so the
  // document under it does not move when the transcript arrives. It can act once the transcript is read.
  const olderThanCorrections = showTranscript && !delivered && hasDocument && correctionsNewerThanDocument(run, stepResults, savedSets(savedCorrections));
  const regenerates = Boolean(offer || olderThanCorrections);
  // What the newer corrections change, said from the first draw: by the run's own read until the transcript is read.
  const newer = transcript.pending ? savedTranscriptCorrections(stepResults, savedSets(savedCorrections)) : editing.corrections;
  // A finished run's speakers can be named (Eneo changes names only on a completed run); names typed and not saved are
  // kept for this person through a reload.
  const user = useAuthenticatedUser();
  const namesDraft = { ownerId: user.id, name: `names:${run.id}` };
  const naming = run.status.toLowerCase() === "completed" ? { draftKey: namesDraft, thing: words.thing, delivered, hasDocument } : undefined;
  // The details the run was started with (meeting name, participants), as the failure and progress views show them:
  // only on the flow version the contract describes, and only the filled ones.
  const fields = contract?.form_fields ?? [];
  const details = (run.input_payload_json ?? {}) as Record<string, unknown>;
  const detailsLine = contract && ofContractVersion(run, contract) && detailRows(fields, details).length > 0 ? detailsSummary(fields, details) : null;
  // A document Eneo made again from a reviewed transcript says so; it is not a sign that anyone checked it.
  const fromReviewed = Boolean((run.input_payload_json as { transcript_regeneration?: unknown } | null | undefined)?.transcript_regeneration);
  const wide = useMediaQuery(LAPTOP, true);
  // One playback for the page: the transcript's player, and the pause beside the document on a phone.
  const sources = useMemo(
    () => transcript.fileIds.map((id) => ({ url: inputFileAudioUrl(flowId, run.id, id), durationMs: null })),
    [flowId, run.id, transcript.fileIds],
  );
  const playback = usePlayback(sources);
  // Where this run's recording was left in this browser: put back once its parts are known, and kept from there.
  useEffect(() => (sources.length ? rememberPosition(playback, run.id, browserStorage()) : undefined), [playback, run.id, sources]);
  const tabs = !wide && showTranscript;
  const sideBySide = wide && showTranscript;
  // Names typed and not saved bring their dialog back, open: on a phone it is in the transcript's tab.
  const [view, setView] = useState<View>(() => (naming && hasNamesDraft(namesDraft) ? "transcript" : "document"));
  const tabList = useRef<HTMLElement | null>(null);
  // Each tab keeps its own reading position; the first visit starts at the top of the tab.
  const positions = useRef<Partial<Record<View, number>>>({});
  // A button of the tab being left (the docked player's) changes the tab: the focus goes to the tab it chose.
  const focusTab = useRef(false);
  const switchView = (next: View, { focus = false } = {}) => {
    positions.current[view] = window.scrollY;
    focusTab.current = focus;
    setView(next);
  };
  useLayoutEffect(() => {
    if (!tabs) return;
    const top = (tabList.current?.getBoundingClientRect().top ?? 0) + window.scrollY - 8;
    const saved = positions.current[view];
    window.scrollTo({ top: saved ?? Math.min(window.scrollY, top) });
    if (focusTab.current) document.getElementById(PANELS[view].tab)?.focus({ preventScroll: true });
    focusTab.current = false;
  }, [view, tabs]);

  const documentColumn = (
    <>
      {note && <Text as="p">{note}</Text>}
      {empty && (
        <VStack gap={3}>
          <Text as="p">Körningen blev klar, men flödet gav inget att visa.</Text>
          {onStartAgain && (
            <HStack>
              <Button label="Starta en ny körning" variant="primary" size="lg" icon={<Icon icon={Plus} />} onClick={() => leaveFirst(onStartAgain)} />
            </HStack>
          )}
        </VStack>
      )}
      {regenerates && (
        <RegenerateNotice
          offer={offer}
          reading={transcript.pending}
          saveState={editing.saveState}
          onStarted={onRegenerated}
          onReload={reload}
          thing={words.thing}
          namesOnly={Boolean(newer && namesOnly(newer))}
        />
      )}
      {(text || primary) && <ResultDocument flowId={flowId} runId={run.id} text={text} file={primary} title={flowName} preview={preview} textIsPreview={run.result?.kind === "file_backed_text"} label={words.named} downloadName={runFileName(flowName, run.created_at)} />}
      {others.length > 0 && (
        <ResultFiles flowId={flowId} runId={run.id} files={others} title={primary ? "Fler filer" : "Filer"} />
      )}
      <StepDetails steps={steps} version={run.flow_version} className={styles.steps} />
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
      naming={naming}
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
      className={className ? `${styles.panel} ${className}` : styles.panel}
    >
      {content}
    </section>
  );

  return (
    // The frame gives the page its width and edges, and every result has the whole column; its text keeps a reading
    // measure in it (Markdown). With the transcript beside the text it is a workspace, whose column grows with a wide
    // window (styles/globals.css). One tree for every width, so the transcript (and a correction being written in it) stays mounted when the window
    // crosses the laptop breakpoint: below it the heading, the tabs and the two panels in one column; from it the
    // heading and the document 7 columns of 13 and the transcript 6 beside them, from the page's top, so that it ends in
    // the window before the page is scrolled. Below it a hidden panel is an empty span, which takes no room between
    // rows because the grid has no row gap.
    <VStack paddingBlockStart={2} data-workspace={showTranscript || undefined}>
      <Grid columns={sideBySide ? 13 : 1} columnGap={8} className={styles.columns}>
        <GridSpan columns={sideBySide ? 7 : "full"}>
          <VStack gap={6}>
            <HStack hAlign="between" vAlign="end" wrap="wrap" gap={3}>
              <VStack gap={1}>
                <Heading level={1} ref={heading} tabIndex={-1}>
                  {delivered ? "Resultatet är skickat" : empty ? "Resultatet är tomt" : words.ready}
                </Heading>
                {finished && (
                  <Text as="p" type="supporting">
                    {/* The flow's name at every width: the top bar holds no name. */}
                    {flowName} ·{" "}
                    Skapad {formatRelativeDate(finished)}
                    {fromReviewed && " från den rättade transkriberingen"}
                  </Text>
                )}
                {detailsLine && (
                  // Two lines at most (a council has many participants): the rest on hover, all of it to a screen reader.
                  <Text as="p" type="supporting" maxLines={2}>
                    {detailsLine}
                  </Text>
                )}
              </VStack>
              <HStack vAlign="center" gap={2}>
                <Button variant="ghost" icon={<Icon icon={audio ? Mic : Plus} />} label={audio ? "Ny inspelning" : "Ny körning"} onClick={() => leaveFirst(onNewRecording)} />
              </HStack>
            </HStack>
            <VStack gap={4}>
              {tabs && (
                <TabList ref={tabList} role="tablist" aria-label="Visa" value={view} onChange={(next) => switchView(next as View)}>
                  {/* The notice that the document can be made again is in this panel: while the other tab is chosen it is
                      out of sight, and this tab carries a dot whose words go on from the tab's own ("Dokument kan
                      skapas igen med rättningarna", the notice's own verb), and say so on hover too. With this tab chosen
                      the notice itself is there, and the dot would only repeat it. */}
                  <Tab
                    value="document"
                    id={PANELS.document.tab}
                    panelId={PANELS.document.panel}
                    label={words.tab}
                    endContent={
                      regenerates && view === "transcript" ? (
                        <StatusDot
                          variant="accent"
                          label="kan skapas igen med rättningarna"
                          tooltip={`${words.tab} kan skapas igen med rättningarna`}
                        />
                      ) : undefined
                    }
                  />
                  <Tab value="transcript" id={PANELS.transcript.tab} panelId={PANELS.transcript.panel} label="Transkribering" />
                </TabList>
              )}
              {panel(
                "document",
                view === "document",
                <VStack gap={6}>
                  {documentColumn}
                  {tabs && <PausePlayback playback={playback} onShow={() => switchView("transcript", { focus: true })} />}
                </VStack>,
              )}
            </VStack>
          </VStack>
        </GridSpan>
        {transcriptColumn && (
          <GridSpan columns={sideBySide ? 6 : "full"}>
            {panel("transcript", view === "transcript", transcriptColumn, tabs ? styles.afterTabs : styles.sticky)}
          </GridSpan>
        )}
      </Grid>
    </VStack>
  );
}

/**
 * On a phone's Dokument tab, once the recording has played: its pause (or play)
 * and time, docked at the bottom, driven by the transcript's player itself.
 */
function PausePlayback({ playback, onShow }: { playback: Playback; onShow: () => void }): ReactNode {
  const state = usePlaybackState(playback);
  const [, dockRef] = useDock();
  if (!state.started) return null;
  const pauses = state.playing || state.starting;
  return (
    <HStack ref={dockRef} data-docked-player className={styles.docked} vAlign="center" gap={3}>
      <Button
        isIconOnly
        icon={<Icon icon={pauses ? Pause : Play} />}
        label={pauses ? "Pausa uppspelningen" : "Spela upp"}
        onClick={() => playback.toggle()}
      />
      <Text type="supporting" hasTabularNumbers>
        {formatClock(state.atMs)} / {formatClock(state.totalMs)}
      </Text>
      <Button variant="ghost" label="Visa i transkriberingen" onClick={onShow} />
    </HStack>
  );
}
