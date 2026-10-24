import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, Mic, Pause, Play, Plus } from "lucide-react";
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
import { useNarrowerThan } from "./useRoomInRow";
import { useWorkspace } from "@/lib/workspace";
import { formatClock, formatRelativeDate } from "@/lib/format";
import { participantsOf } from "@/lib/participants";
import { detailRows, detailsSummary } from "@/lib/recording-view";
import type { Playback } from "@/lib/playback";
import { rememberPosition } from "@/lib/playback-position";
import { fileText, runFileName, transcriptFileName, type ResultFileView } from "@/lib/run-files";
import { ofContractVersion, type StepView } from "@/lib/run-progress";
import { outputWords, resultFileIds, runOutput, runResultView } from "@/lib/run-result";
import { ResultDocument } from "./ResultDocument";
import { IconTile } from "@/components/IconTile";
import { useAuthenticatedUser } from "@/components/AuthGate";
import { hasNamesDraft } from "@/components/SpeakerNamingDialog";
import { browserDrafts } from "@/lib/drafts";
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

/** Where the result's tab chosen is kept for a run: this tab of the browser (sessionStorage), never another device. */
const viewKey = (runId: string) => `tal-till-text:result-view:${runId}`;

/** The tab last chosen for the run in this tab of the browser, else Dokument. */
function keptView(runId: string): View {
  try {
    const kept = browserDrafts()?.getItem(viewKey(runId));
    return kept === "transcript" ? "transcript" : "document";
  } catch {
    return "document";
  }
}

function keepView(runId: string, view: View) {
  try {
    browserDrafts()?.setItem(viewKey(runId), view);
  } catch {
    // A browser that keeps nothing for the page: the next load starts on Dokument.
  }
}

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
  const { transcript, confirmedWords, editing } = useRunTranscript(flowId, run.id, stepResults, showTranscript, savedCorrections);
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
  // The details the run was started with (meeting name, participants), as the failure and progress views show them:
  // only on the flow version the contract describes, and only the filled ones.
  const fields = contract?.form_fields ?? [];
  const details = (run.input_payload_json ?? {}) as Record<string, unknown>;
  // The people the run was started with, offered as names: from the field Eneo says holds them, on the contract's version.
  const participantsField = contract && ofContractVersion(run, contract) ? contract.transcription?.max_speakers?.participants_field : null;
  const participants = participantsField ? participantsOf(details[participantsField]) : [];
  const naming = run.status.toLowerCase() === "completed" ? { draftKey: namesDraft, thing: words.thing, delivered, hasDocument, participants } : undefined;
  const detailsLine = contract && ofContractVersion(run, contract) && detailRows(fields, details).length > 0 ? detailsSummary(fields, details) : null;
  // Under 16 rem of the root's text (the reader's large text, a phone's zoom) two lines hold a word or two of them: there
  // they are whole.
  const headRoom = useNarrowerThan(16);
  // A document Eneo made again from a reviewed transcript says so; it is not a sign that anyone checked it.
  const fromReviewed = Boolean((run.input_payload_json as { transcript_regeneration?: unknown } | null | undefined)?.transcript_regeneration);
  const wide = useMediaQuery(LAPTOP, true);
  const metaStacked = useMediaQuery("(max-width: 639.98px)");
  // The narrowest phones: the flow's name and when it was made each take a line, where the two would break after the dot.
  const tiny = useMediaQuery("(max-width: 359.98px)");
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
  // With the transcript beside the text it is a workspace, whose column grows with a wide window (lib/workspace.ts).
  useWorkspace(showTranscript);
  // Names typed and not saved bring their dialog back, open: on a phone it is in the transcript's tab.
  // Below a laptop's width the tab chosen is kept for the run in this tab of the browser, through a reload and the
  // reload a phone does to a page left in the background.
  const [view, setView] = useState<View>(() => (naming && hasNamesDraft(namesDraft) ? "transcript" : keptView(run.id)));
  const tabList = useRef<HTMLElement | null>(null);
  // Each tab keeps its own reading position; the first visit starts at the top of the tab, the tabs at the window's top,
  // so a phone shows the passages and not the head again. The page's first view starts at its top, with its heading.
  const positions = useRef<Partial<Record<View, number>>>({});
  const switched = useRef(false);
  // A button of the tab being left (the docked player's) changes the tab: the focus goes to the tab it chose.
  const focusTab = useRef(false);
  const switchView = (next: View, { focus = false } = {}) => {
    keepView(run.id, next);
    positions.current[view] = window.scrollY;
    switched.current = true;
    focusTab.current = focus;
    setView(next);
  };
  useLayoutEffect(() => {
    if (!tabs) return;
    const top = (tabList.current?.getBoundingClientRect().top ?? 0) + window.scrollY - 8;
    const saved = positions.current[view];
    window.scrollTo({ top: saved ?? (switched.current ? top : Math.min(window.scrollY, top)) });
    if (focusTab.current) document.getElementById(PANELS[view].tab)?.focus({ preventScroll: true });
    focusTab.current = false;
  }, [view, tabs]);

  // Starting over is the page's quiet way, the least likely next step: a ghost button at the end of the title's row from
  // 640 px; on a phone at the end of the document, its icon on the edge the document's parts share, where it costs the
  // first screen nothing.
  const newRun = (
    <Button
      variant="ghost"
      icon={<Icon icon={audio ? Mic : Plus} />}
      label={audio ? "Ny inspelning" : "Ny körning"}
      className={metaStacked ? styles.quietStart : styles.quietEnd}
      onClick={() => leaveFirst(onNewRecording)}
    />
  );

  // Only what the run has: the flow's name at every width (the top bar holds none) and when it was made, beside each other
  // where the line has room, then the details it was started with on a line of their own, so their length never breaks
  // the first line. Each a paragraph, so they are read apart.
  const flow = (
    <Text as="p" color="secondary">
      {flowName}
    </Text>
  );
  const made = finished && (
    <Text as="p" color="secondary" hasTabularNumbers>
      Skapad {formatRelativeDate(finished)}
      {fromReviewed && " från den rättade transkriberingen"}
    </Text>
  );
  // The heading says the state in words; from 640 px its tile stands beside it, on a phone the heading has the line.
  const title = (
    <HStack gap={3} vAlign="center">
      {!empty && !metaStacked && <IconTile icon={CheckCircle2} hue="green" />}
      <Heading level={1} ref={heading} tabIndex={-1}>
        {delivered ? "Resultatet är skickat" : empty ? "Resultatet är tomt" : words.ready}
      </Heading>
    </HStack>
  );
  const head = (
    <VStack gap={2} ref={headRoom.ref}>
      {/* From 640 px "Ny inspelning" shares the title's row alone, centred on it, so the lines under it have the column's
          width. */}
      {metaStacked ? (
        title
      ) : (
        <HStack hAlign="between" vAlign="center" gap={3}>
          {title}
          {newRun}
        </HStack>
      )}
      {/* The dot stays with the flow's name, so a line too short for both breaks after it, as a recording's name does: in
          its line, after its last word (a long name that wraps keeps it there, not at the column's end). Under 360 px,
          where it would end the first line alone, each has a line of its own and there is no dot. */}
      {tiny ? (
        <VStack gap={0.5}>
          {flow}
          {made}
        </VStack>
      ) : (
        <HStack gap={1} vAlign="start" wrap="wrap">
          <Text as="p" color="secondary">
            {flowName}
            {made && (
              <Text color="secondary" aria-hidden>
                {"\u00a0·"}
              </Text>
            )}
          </Text>
          {made}
        </HStack>
      )}
      {detailsLine && (
        // Two lines at most (a council has many participants): the rest on hover, all of it to a screen reader.
        <Text as="p" color="secondary" maxLines={headRoom.narrow ? undefined : 2}>
          {detailsLine}
        </Text>
      )}
    </VStack>
  );
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
          onReload={editing.readAgain}
          thing={words.thing}
          namesOnly={Boolean(newer && namesOnly(newer))}
        />
      )}
      {(text || primary) && <ResultDocument flowId={flowId} runId={run.id} text={text} file={primary} title={flowName} preview={preview} textIsPreview={run.result?.kind === "file_backed_text"} label={words.named} downloadName={runFileName(flowName, run.created_at)} />}
      {others.length > 0 && (
        <ResultFiles flowId={flowId} runId={run.id} files={others} title={primary ? "Fler filer" : "Filer"} />
      )}
      {metaStacked && <HStack>{newRun}</HStack>}
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
      onReload={editing.readAgain}
      playback={playback}
      naming={naming}
      ownerId={user.id}
      headingHidden={tabs}
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
    <VStack paddingBlockStart={2}>
      <Grid columns={sideBySide ? 13 : 1} columnGap={8} className={styles.columns}>
        <GridSpan columns={sideBySide ? 7 : "full"}>
          {/* Below a laptop's width the tabs stand 12 px under the head, whose views they are; beside the transcript the
              document stands 24 px under it. */}
          <VStack gap={tabs ? 3 : 6}>
            {head}
            <VStack gap={4}>
              {tabs && (
                <TabList ref={tabList} role="tablist" aria-label="Visa" value={view} onChange={(next) => switchView(next as View)} className={styles.tabs}>
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
                        // No tooltip: it would stand in the tab strip, which owns only its tabs; the dot's words join the
                        // tab's name, and the tabs are a touch screen's, where there is no hover to show one.
                        <StatusDot variant="accent" label="kan skapas igen med rättningarna" />
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
