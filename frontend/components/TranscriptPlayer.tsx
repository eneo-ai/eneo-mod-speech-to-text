import { AlertTriangle, Check, ChevronDown, ChevronUp, Download, Pencil, RotateCcw, RotateCw, UsersRound } from "lucide-react";
import {
  type ComponentProps,
  type ComponentType,
  Fragment,
  memo,
  type ReactNode,
  type Ref,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Divider } from "@astryxdesign/core/Divider";
import { DropdownMenu, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@astryxdesign/core/DropdownMenu";
import { Heading } from "@astryxdesign/core/Heading";
import { useAnnounce, useMediaQuery } from "@astryxdesign/core/hooks";
import { HStack } from "@astryxdesign/core/HStack";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Selector } from "@astryxdesign/core/Selector";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ToggleButton, ToggleButtonGroup } from "@astryxdesign/core/ToggleButton";
import { VStack } from "@astryxdesign/core/VStack";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import type { TranscriptEditor } from "@/components/TranscriptEditor";
import { SpeakerMark } from "@/components/SpeakerMark";
import { SpeakerNamingDialog, type SpeakerNamingHandle } from "@/components/SpeakerNamingDialog";
import { AudioPlayer, usePlayback, usePlaybackFlags, usePlaybackState } from "@/components/flow/AudioPlayer";
import { useRoomInRow } from "@/components/flow/useRoomInRow";
import { useTranscriptPlayhead } from "@/lib/transcript-playhead";
import styles from "@/components/TranscriptPlayer.module.css";
import { useDock } from "@/lib/dock";
import { browserStorage } from "@/lib/browser-storage";
import { downloadBlob } from "@/lib/download";
import { letterKeysOn, setLetterKeysOn } from "@/lib/letter-keys";
import { scrollBehavior } from "@/lib/motion";
import { LoadFailure } from "@/components/LoadFailure";
import { useSignedOut } from "@/components/AuthGate";
import { ActionRow } from "@/components/ActionRow";
import { lazyLoader, useLoaded } from "@/lib/lazy-component";
import { formatClock } from "@/lib/format";
import type { Playback, PlayerSource } from "@/lib/playback";
import { SPEAKER_REVIEW_ENABLED, type FileSpeakerReview } from "@/lib/speaker-review";
import type { SpeakerMappingRow } from "@/lib/speaker-mapping";
import { countUncertain, wordKey } from "@/lib/confirmed-words";
import {
  computeTurns,
  countFiles,
  effectiveSpeakerLabel,
  findHits,
  firstSegmentForSpeaker,
  paragraphTurns,
  pendingSpeakerReview,
  speakerColorIndex,
  speakerName,
  speakerSummaries,
  type SearchHit,
  type TranscriptSegment,
  type TranscriptTurn,
  type TranscriptTurnPart,
  type TranscriptWord,
} from "@/lib/transcript";
import {
  applyCorrections,
  occurrencesForLine,
  withLineCorrection,
  withSpeakerDecision,
  withSpeakerEdit,
  correctedSegmentText,
  correctionWriteProblem,
  effectiveSpeakerNames,
  MAX_SPEAKER_EDITS,
  namesAfterNaming,
  renderReviewedTranscript,
  sameCorrections,
  type CorrectedRange,
  type CorrectionSet,
  type SpeakerNames,
} from "@/lib/transcript-corrections";

export type CorrectionsSaveState = "idle" | "saving" | "saved" | "error";

/**
 * Naming the speakers of a finished run: the dialog's words, where names typed and not yet saved are kept, and the save
 * of the names, laid on the page's corrections as they are then, which resolves with why they were not saved, or null;
 * and the people the run was started with, offered as names.
 */
type Naming = {
  description: string;
  draftKey: { ownerId: string; name: string };
  save: (names: SpeakerNames) => Promise<string | null>;
  participants: readonly string[];
};

const RATES = [0.75, 1, 1.25, 1.5, 2];
const NO_SOURCES: readonly PlayerSource[] = [];
const EMPTY_SET: ReadonlySet<string> = new Set();
const NO_HITS: ReadonlyMap<number, Hit[]> = new Map();
const SKIP_SECONDS = 10;
/** The picker's value for "the speaker cannot be told". */
const UNRESOLVED = "__unresolved";
type SpeakerPickerTrigger = Pick<ComponentProps<typeof Button>, "ref" | "onClick" | "aria-haspopup" | "aria-expanded" | "aria-controls">;
/** The filter value for the passages Eneo asks someone to check: a to-do, not a speaker. */
const TO_CHECK = "__check";
/** Above this many speakers a phone picks one from a list instead of scrolling chips. */
const CHIP_LIMIT = 5;

/**
 * The transcript's keys: Space or K plays and pauses, the arrow keys move five
 * seconds, J and L ten. `skipMs` 0 toggles.
 * A key held with Ctrl, Cmd or Alt is the browser's or the system's (Alt+←
 * goes back, Cmd+K, Ctrl+L), never the player's.
 */
export function shortcut({ key, altKey, ctrlKey, metaKey }: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey">): {
  skipMs: number;
  preventDefault: boolean;
} | null {
  if (altKey || ctrlKey || metaKey) return null;
  switch (key.length === 1 ? key.toLowerCase() : key) {
    case " ":
    case "k":
      return { skipMs: 0, preventDefault: true };
    case "ArrowLeft":
      return { skipMs: -5_000, preventDefault: true };
    case "ArrowRight":
      return { skipMs: 5_000, preventDefault: true };
    case "j":
      return { skipMs: -SKIP_SECONDS * 1_000, preventDefault: false };
    case "l":
      return { skipMs: SKIP_SECONDS * 1_000, preventDefault: false };
    default:
      return null;
  }
}

/** The class names that apply, joined: a CSS Module's names and a caller's own. */
const join = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

/** The same function from render to render, calling the latest `fn`: a passage given it renders again only when it changes. */
function useSteady<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: A) => latest.current(...args), []);
}

function rateLabel(rate: number): string {
  return `${String(rate).replace(".", ",")}×`;
}

type EditorProps = ComponentProps<typeof TranscriptEditor>;

// The editor is the review's largest part, shown only where its setting is on: its code loads when it is first shown (a
// page that never shows it never loads it), and is kept for the next. Until it has arrived a placeholder holds its place.
const editor = lazyLoader<ComponentType<EditorProps>>(() => import("@/components/TranscriptEditor").then((module) => module.TranscriptEditor));
/** Loads the editor ahead of its being shown: a test that renders it as markup waits for this first. */
export const preloadTranscriptEditor = () => editor.load();

/** The review editor, following playback itself: it lights words as it renders, so it is the one part rendered again as the audio plays. */
function ReviewEditorAtPlayhead({
  playback,
  hasAudio,
  ...props
}: Omit<EditorProps, "currentFile" | "currentTime" | "playing" | "audioAvailable"> & { playback: Playback; hasAudio: boolean }) {
  const position = usePlaybackState(playback);
  // Nothing is lit until playback has started or been moved.
  const currentTime = position.started ? position.withinMs / 1_000 : Number.NEGATIVE_INFINITY;
  return (
    <LazyTranscriptEditor
      {...props}
      audioAvailable={hasAudio && !position.unavailable}
      currentFile={position.part}
      currentTime={currentTime}
      playing={position.playing}
    />
  );
}

/** The speed, chosen from a menu: any speed in one step, never a round through the others. */
function SpeedMenu({ playback, rate, className }: { playback: Playback; rate: number; className: string }) {
  return (
    <DropdownMenu
      button={{ label: `Hastighet ${rateLabel(rate)}`, children: rateLabel(rate), variant: "ghost", size: "sm", className }}
      placement="above"
      alignment="end"
    >
      <DropdownMenuRadioGroup label="Hastighet" value={String(rate)} onChange={(value) => playback.setRate(Number(value))}>
        {RATES.map((option) => (
          <DropdownMenuRadioItem key={option} value={String(option)} label={rateLabel(option)} />
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenu>
  );
}

/**
 * The controls docked under the transcript: the keys, Följ, speed, the player and its skips, as playback stands. Each
 * control names its key (`shortcut`) to a screen reader while the letter keys are on; the line above them names the
 * keys to the eye, and turns the letters off and on. No tooltip: shown on keyboard focus, one lies over its neighbours
 * in this row.
 */
function PlayerControls({
  playback,
  dock,
  follow,
  onFollow,
  letterKeys,
  onLetterKeys,
}: {
  playback: Playback;
  dock: HTMLElement | null;
  follow: boolean;
  onFollow: () => void;
  /** Whether K, J and L act (lib/letter-keys.ts); null where they are not said, and do nothing (KEYS_SAID). */
  letterKeys: boolean | null;
  onLetterKeys: (on: boolean) => void;
}) {
  const { rate, unavailable, atStart, atEnd } = usePlaybackFlags(playback);

  function skipFromControl(milliseconds: number, trigger: HTMLElement) {
    playback.skip(milliseconds);
    const next = playback.getSnapshot();
    // The pressed control becomes disabled at a boundary. Keep keyboard focus in the player, on its position.
    if (document.activeElement === trigger && (next.atMs === 0 || next.atEnd)) {
      dock?.querySelector<HTMLElement>('[role="slider"]')?.focus();
    }
  }

  return (
    <>
      {/* Above the player's row: in it, on a phone, they would leave the position slider a few pixels. Speed sits in the
          row from 400 px (below it the copy here is shown, and the one in the row is not). The keys are said once,
          where there is a keyboard to press them (KEYS_SAID), and act only there. The line ends with its own button,
          which turns the letters off, and on again: the focus stays on it, and the line's new words are said. */}
      <div className={styles.dockTools}>
        {letterKeys !== null && (
          <Text type="supporting" className={styles.keys}>
            {letterKeys ? "Tangenter: K spelar och pausar, J och L hoppar 10 sekunder." : "Tangenterna K, J och L är avstängda."}{" "}
            <Button
              variant="ghost"
              size="sm"
              className={styles.keysToggle}
              label={letterKeys ? "Stäng av tangenterna" : "Slå på tangenterna"}
              onClick={() => onLetterKeys(!letterKeys)}
            >
              {letterKeys ? "Stäng av" : "Slå på"}
            </Button>
          </Text>
        )}
        {!follow && <Button variant="ghost" size="sm" label="Följ" onClick={onFollow} />}
        <SpeedMenu playback={playback} rate={rate} className={styles.rateBelow} />
      </div>
      <AudioPlayer playback={playback} label="Inspelningen" playKey={letterKeys ? "K" : undefined}>
        <IconButton
          variant="ghost"
          className={styles.skip}
          isDisabled={unavailable || atStart}
          label={`Bakåt ${SKIP_SECONDS} sekunder`}
          aria-keyshortcuts={letterKeys ? "J" : undefined}
          icon={<RotateCcw aria-hidden />}
          onClick={(event) => skipFromControl(-SKIP_SECONDS * 1_000, event.currentTarget)}
        />
        <IconButton
          variant="ghost"
          className={styles.skip}
          isDisabled={unavailable || atEnd}
          label={`Framåt ${SKIP_SECONDS} sekunder`}
          aria-keyshortcuts={letterKeys ? "L" : undefined}
          icon={<RotateCw aria-hidden />}
          onClick={(event) => skipFromControl(SKIP_SECONDS * 1_000, event.currentTarget)}
        />
        <SpeedMenu playback={playback} rate={rate} className={styles.rate} />
      </AudioPlayer>
    </>
  );
}

function LazyTranscriptEditor(props: EditorProps) {
  const { value: Editor, failed } = useLoaded(editor);
  if (Editor) return <Editor {...props} />;
  // If its code cannot be fetched (a tab older than the deploy that replaced its files) the placeholder says so and
  // offers the person's reload, which gives back the review's draft; the page does not reload by itself.
  if (failed) {
    return (
      <div className={styles.editorPending}>
        <LoadFailure keeps="Det du har skrivit finns kvar.">Granskningsverktygen kunde inte läsas in.</LoadFailure>
      </div>
    );
  }
  return (
    <div className={styles.editorPending} aria-busy="true">
      <VisuallyHidden as="p" role="status">
        Hämtar granskningsverktygen…
      </VisuallyHidden>
      <Skeleton width="100%" height={40} />
      <Skeleton width="60%" height={16} />
      <Skeleton width="100%" height={16} />
      <Skeleton width="90%" height={16} />
    </div>
  );
}

/**
 * Where the page scrolls and the window is wide enough for the player's row of controls (a tablet, a narrow laptop
 * window), a player stuck to the window's bottom would cover the passages the window starts on. There it stands above
 * the text, under the tools, and stays at the window's top while the text is read. A phone keeps it under the text,
 * where a thumb reaches it; a laptop's card and a short screen keep it at the text's end (TranscriptPlayer.module.css).
 */
const PLAYER_ON_TOP = "(min-width: 640px) and (max-width: 1023.98px) and (min-height: 601px)";

/**
 * Where the player's letter keys are said, and so where they act: with a mouse, where there is a keyboard to press them.
 * A touch screen has no line for them, and so nothing to turn them off with (WCAG 2.1.4): there K, J and L do nothing,
 * and the player's buttons play, as do Space and the arrows with the focus in it.
 */
const KEYS_SAID = "(hover: hover) and (pointer: fine)";

/**
 * The passage is in the middle of what can be read (the list where it scrolls, else the window), away from the edges,
 * so following playback leaves it where it is: the text moves only when the playhead nears an edge, not at every new
 * sentence.
 */
function withinReadingZone(block: HTMLElement, list: HTMLElement): boolean {
  const scrolls = list.scrollHeight > list.clientHeight;
  const { top, height } = scrolls ? list.getBoundingClientRect() : { top: 0, height: window.innerHeight };
  const box = block.getBoundingClientRect();
  return box.top >= top + height * 0.15 && box.bottom <= top + height * 0.85;
}

type Piece = {
  text: string;
  word: TranscriptWord | null;
  wordIndex: number;
  /** The original text, when the piece is a corrected span. */
  correctedFrom: string | null;
  /** A search hit: "current" is the one the arrows are on. */
  hit: "match" | "current" | null;
};

type Hit = { start: number; end: number; current: boolean };

/** The segment's text divided at every word, correction and search boundary, so a piece is plain text, a timed word or a corrected span. */
function pieces(segment: TranscriptSegment, ranges: readonly CorrectedRange[], hits: readonly Hit[] = []): Piece[] {
  const text = segment.text;
  const words = (segment.words ?? [])
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => w.charStart >= 0);
  const cuts = new Set<number>([0, text.length]);
  for (const { w } of words) {
    cuts.add(w.charStart);
    cuts.add(w.charEnd);
  }
  for (const r of [...ranges, ...hits]) {
    cuts.add(r.start);
    cuts.add(r.end);
  }
  const bounds = [...cuts].filter((c) => c >= 0 && c <= text.length).sort((a, b) => a - b);
  const out: Piece[] = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const start = bounds[k];
    const end = bounds[k + 1];
    if (end <= start) continue;
    const word = words.find(({ w }) => w.charStart <= start && w.charEnd >= end);
    const range = ranges.find((r) => r.start <= start && r.end >= end && r.end > r.start);
    const hit = hits.find((h) => h.start <= start && h.end >= end);
    out.push({
      text: text.slice(start, end),
      word: word?.w ?? null,
      wordIndex: word?.i ?? -1,
      correctedFrom: range ? range.original : null,
      hit: hit ? (hit.current ? "current" : "match") : null,
    });
  }
  // A plain deletion leaves no span to point at: a narrow marker stands in its place.
  for (const r of ranges) {
    if (r.end === r.start) {
      const at = out.findIndex((_, idx) => bounds[idx] >= r.start);
      const marker: Piece = { text: "\u202f", word: null, wordIndex: -1, correctedFrom: r.original, hit: null };
      if (at < 0) out.push(marker);
      else out.splice(at, 0, marker);
    }
  }
  return out;
}

/**
 * The part of its source sentence a displayed passage is, in the sentence's own
 * characters, or null when it is the whole sentence and no other speaker has a
 * span of it.
 */
function sourceSpan(
  part: TranscriptTurnPart,
  segments: readonly TranscriptSegment[],
  set: CorrectionSet,
): { from: number; to: number } | null {
  const source = part.segment.sourceSegmentIndex ?? part.segmentIndex;
  const length = segments[source]?.text.length ?? 0;
  const from = part.segment.sourceCharStart ?? 0;
  const to = part.segment.sourceCharEnd ?? length;
  const shared = set.speaker_edits.some((e) => e.segment_index === source && e.char_start !== null);
  return from === 0 && to === length && !shared ? null : { from, to };
}

export function TranscriptPlayer(
  {
    segments,
    speakerReviews = [],
    reviewEnabled = SPEAKER_REVIEW_ENABLED,
    correctionProblem,
    fileCount,
    audioSrcFor,
    speakerNames,
    textFallback,
    audioPending = false,
    className,
    corrections,
    editable = false,
    onCorrectionsChange,
    speakerOptions,
    saveState = "idle",
    confirmedWords = EMPTY_SET,
    onToggleConfirmed,
    title,
    playback: shared,
    naming,
    onRenameSpeaker,
    ownerId,
    actions,
  }: {
    /** The raw segments; corrections are laid over them when shown. */
    segments: readonly TranscriptSegment[];
    speakerReviews?: readonly FileSpeakerReview[];
    reviewEnabled?: boolean;
    correctionProblem?: string | null;
    /** The number of audio files; 0 is no audio, a transcript to read only. */
    fileCount: number;
    audioSrcFor: (fileIndex: number) => string;
    /** A raw label to the name the reviewer chose, laid over the segments' labels. */
    speakerNames: Readonly<Record<string, string>>;
    /** Shown when there are no segments at all. */
    textFallback: string;
    audioPending?: boolean;
    className?: string;
    /** The saved and unsaved corrections to show over the raw text. */
    corrections?: CorrectionSet;
    /** Allows correcting a turn and changing its speaker. Needs `onCorrectionsChange`. */
    editable?: boolean;
    onCorrectionsChange?: (next: CorrectionSet) => void;
    /** The labels a turn can be given (SPEAKER_NN). */
    speakerOptions?: readonly string[];
    saveState?: CorrectionsSaveState;
    /** The uncertain words the reviewer has listened to and confirmed (lib/confirmed-words). */
    confirmedWords?: ReadonlySet<string>;
    /** Makes it possible to confirm, or take back, an uncertain word. */
    onToggleConfirmed?: (key: string) => void;
    /**
     * The card's heading, shown over its tools, with the download of the reviewed transcript beside it (as the result's
     * transcript has its actions). Without it the page names the transcript and has its own actions.
     */
    title?: string;
    /**
     * The page's own playback of these parts, when the page shows it elsewhere too
     * (a pause control beside the document); otherwise the transcript owns one.
     */
    playback?: Playback;
    /**
     * Naming the speakers of a finished run: "Namnge talare" in the speakers' row and "Byt namn på" in a passage's
     * Ändra talare. Without it nobody is named here (the review pause names in its own dialog, `onRenameSpeaker`).
     */
    naming?: Naming;
    /**
     * Where the page names its speakers itself (the review pause's dialog): "Byt namn på" in a passage's Ändra talare
     * opens that, at the passage's speaker, and the focus goes back to `returnTo`.
     */
    onRenameSpeaker?: (label: string, returnTo: HTMLElement | null) => void;
    /** The signed-in person, whose choice of the letter keys this browser keeps; without one it lasts while shown. */
    ownerId?: string;
    /**
     * The page's own actions for the transcript (its copy and download, where the page has no heading row for them): at
     * the end of the speakers' row where they can be named, else on a row of their own. Labelled where the row has room
     * for them (`fits`), folded into one menu where it has not.
     */
    actions?: (fits: boolean) => ReactNode;
  },
) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const programmaticScrollUntil = useRef(0);
  const pastId = useId();

  const [follow, setFollow] = useState(true);
  const [dock, dockRef] = useDock();
  const playerOnTop = useMediaQuery(PLAYER_ON_TOP);
  const [editingIndex, setEditingIndex] = useState(-1);
  const [editError, setEditError] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [hitIndex, setHitIndex] = useState(0);

  const hasAudio = fileCount > 0 && !audioPending;
  // The app's one set of playback controls; the transcript follows its position and seeks through it.
  const own = usePlayback(
    hasAudio && !shared ? Array.from({ length: fileCount }, (_, i) => ({ url: audioSrcFor(i), durationMs: null })) : NO_SOURCES,
  );
  const playback = shared ?? own;
  // The list does not follow playback by rendering: useTranscriptPlayhead lights it, and the controls under it
  // (PlayerControls) render their own state. A list of an hour's meeting takes a fifth of a second to render.

  const applied = useMemo(() => applyCorrections(segments, corrections), [segments, corrections]);
  const shown = applied.segments;
  // A flow without speaker labels names no speaker: "Okänd talare" on every block would mislead.
  const labelled = shown.some((segment) => segment.speaker !== null) || speakerReviews.length > 0;
  const correctedIndices = applied.corrected;
  const correctedRanges = applied.ranges;
  // Unlabelled text reads as paragraphs, one per timed block.
  const turns = useMemo(() => (labelled ? computeTurns(shown) : paragraphTurns(shown)), [shown, labelled]);
  const speakers = useMemo(() => speakerSummaries(turns), [turns]);
  // Each speaker's settled passages, counted once per transcript and its corrections, never per passage or playback tick.
  const settledPassages = useMemo(() => new Map(speakers.map((s) => [s.label, s.passages])), [speakers]);
  const totalFiles = Math.max(fileCount, countFiles(shown), ...speakerReviews.map((r) => r.fileIndex + 1));
  const uncertain = useMemo(() => countUncertain(shown, confirmedWords), [shown, confirmedWords]);
  const uncertainWords = uncertain.remaining + uncertain.confirmed;
  const hasSegments = shown.length > 0;
  const canEdit = editable && !correctionProblem && typeof onCorrectionsChange === "function";
  const canReview = canEdit && reviewEnabled && corrections?.schemaVersion === 3 && !correctionWriteProblem(corrections);
  // A passage Eneo marks for a check takes a decision, which needs Eneo's newer correction format.
  const canDecide = canEdit && corrections?.schemaVersion === 3 && !correctionWriteProblem(corrections);
  const canConfirm = typeof onToggleConfirmed === "function";

  // The names the page shows: a naming step's, with those given after the run over them.
  const names = useMemo(() => effectiveSpeakerNames(speakerNames, corrections?.speakerNames), [speakerNames, corrections?.speakerNames]);
  const displayName = useCallback(
    (label: string | null) => {
      if (!label) return "Okänd talare";
      return speakerName(label, names);
    },
    [names],
  );

  const labelOptions = useMemo(() => {
    const set = new Set<string>(speakerOptions ?? []);
    for (const s of segments) if (s.speaker) set.add(s.speaker);
    for (const e of corrections?.speaker_edits ?? []) if (e.speaker) set.add(e.speaker);
    return [...set].sort();
  }, [speakerOptions, segments, corrections]);

  // Naming after the run, where the passages can be corrected and have speakers to name.
  const canName = naming !== undefined && canEdit && corrections !== undefined && labelled && speakers.length > 0;
  const namingDialog = useRef<SpeakerNamingHandle>(null);
  const actionsRow = useRoomInRow();

  // A filter whose speaker is gone (all their passages moved) shows everyone again.
  const toCheck = turns.filter(pendingSpeakerReview).length;
  const shownFilter =
    filter === TO_CHECK ? (toCheck > 0 ? TO_CHECK : "all") : speakers.some((s) => s.label === filter) ? filter : "all";
  // The chip and the typed letter show at once; the passages and the hits follow them, a render that a next press or
  // letter interrupts: an hour's meeting is two thousand passages.
  const listFilter = useDeferredValue(shownFilter);
  const searched = useDeferredValue(query);
  const visibleTurns = useMemo(
    () =>
      listFilter === "all"
        ? turns
        : listFilter === TO_CHECK
          ? turns.filter(pendingSpeakerReview)
          : turns.filter((turn) => turn.speaker === listFilter && !pendingSpeakerReview(turn)),
    [turns, listFilter],
  );
  const visibleSegments = useMemo(
    () => new Set(visibleTurns.flatMap((turn) => turn.parts.map((part) => part.segmentIndex))),
    [visibleTurns],
  );
  const hits = useMemo(
    () => findHits(shown, searched).filter((hit) => visibleSegments.has(hit.segmentIndex)),
    [shown, searched, visibleSegments],
  );
  const currentHit = hits.length > 0 ? Math.min(hitIndex, hits.length - 1) : -1;
  const hitsBySegment = useMemo(() => {
    const map = new Map<number, Hit[]>();
    hits.forEach((hit: SearchHit, i) => {
      const list = map.get(hit.segmentIndex) ?? [];
      list.push({ start: hit.start, end: hit.end, current: i === currentHit });
      map.set(hit.segmentIndex, list);
    });
    return map;
  }, [hits, currentHit]);

  const seekTo = useCallback(
    (fileIndex: number, time: number, autoplay = false) => {
      if (hasAudio) setFollow(true);
      playback.seek(fileIndex, time * 1_000, autoplay);
    },
    [hasAudio, playback],
  );

  // K, J and L work from anywhere on the page where the line that says them is (KEYS_SAID), so K plays before anything
  // in the player has been clicked, and that line turns them off (WCAG 2.1.4): a letter said to speech input, or pressed
  // by mistake, then does nothing. Where no line says them (a touch screen with a keyboard of its own) they act only
  // with the focus in the player, which 2.1.4 allows. What types or picks with letters keeps them, and so does a dialog
  // over the page. Space and the arrows scroll the page and work its controls: they are the player's only with the focus
  // on it or its text, and the slider moves by its own.
  const playerRef = useRef<HTMLElement | null>(null);
  const keysSaid = useMediaQuery(KEYS_SAID, true);
  const [letterKeys, setLetterKeys] = useState(() => (ownerId ? letterKeysOn(browserStorage(), ownerId) : true));
  const announce = useAnnounce();
  const turnLetterKeys = useSteady((on: boolean) => {
    setLetterKeys(on);
    if (ownerId) setLetterKeysOn(browserStorage(), ownerId, on);
    announce(on ? "Tangenterna K, J och L är påslagna." : "Tangenterna K, J och L är avstängda.");
  });
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const action = shortcut(e);
      if (!action || e.defaultPrevented || !(e.target instanceof Element)) return;
      const target = e.target;
      if (e.key.length === 1 && e.key !== " ") {
        const letters = keysSaid ? letterKeys : Boolean(playerRef.current?.contains(target));
        if (!letters || target.closest("input, textarea, select, [contenteditable], [role=textbox], [role=combobox], [role=listbox], [role=option], [role=menu], [role=menuitem], [role=menuitemradio], dialog, [role=dialog], [role=alertdialog]")) return;
      } else if (!playerRef.current?.contains(target) || target.closest("button, a, input, select, textarea, summary, [role=button], [role=slider], [role=menuitemradio], [role=radio], [role=listbox], [role=option], [contenteditable]")) {
        return;
      }
      if (!hasAudio || playback.getSnapshot().unavailable) return;
      if (action.preventDefault) e.preventDefault();
      if (action.skipMs === 0) playback.toggle();
      else playback.skip(action.skipMs);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [hasAudio, playback, keysSaid, letterKeys]);

  // The sentence being played stays in view, while following and not editing a line.
  const following = useRef({ follow, editing: editingIndex >= 0 });
  following.current = { follow, editing: editingIndex >= 0 };
  const keepInView = useCallback((segmentIndex: number) => {
    if (!following.current.follow || following.current.editing || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-segment-index="${segmentIndex}"]`);
    const block = el?.closest<HTMLElement>("[data-turn-index]") ?? el;
    if (!block || withinReadingZone(block, listRef.current)) return;
    programmaticScrollUntil.current = Date.now() + 800;
    block.scrollIntoView({ block: "center", behavior: scrollBehavior() });
  }, []);
  // The review editor lights its own words; the playhead only keeps its place in view there.
  const playheadAt = useTranscriptPlayhead(listRef, playback, shown, keepInView, !reviewEnabled);
  // Following again, or closing a line's editor, brings the playhead's sentence back.
  useEffect(() => {
    const at = playheadAt();
    if (at >= 0) keepInView(at);
  }, [follow, editingIndex, playheadAt, keepInView]);

  // The search's current hit is brought into view, and playback stops pulling the text away from it. At once, as a
  // browser's own find does: a glide restarted by every typed letter or step lags behind the hit it goes to.
  useEffect(() => {
    if (currentHit < 0 || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>('[data-hit="current"]');
    if (!el) return;
    programmaticScrollUntil.current = Date.now() + 800;
    setFollow(false);
    el.scrollIntoView({ block: "center", behavior: "instant" });
  }, [currentHit, searched]);

  function onUserScroll() {
    if (Date.now() < programmaticScrollUntil.current) return;
    if (follow) setFollow(false);
  }

  function stepHit(by: number) {
    if (hits.length === 0) return;
    setHitIndex(((currentHit < 0 ? 0 : currentHit) + by + hits.length) % hits.length);
  }

  function onPartClick(part: TranscriptTurnPart, e: React.MouseEvent) {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    if (editingIndex >= 0) return;
    // A word plays from where it is said, as "Spela från" plays the passage: also from a pause. Without word times, from
    // the sentence's start.
    const wordEl = (e.target as HTMLElement).closest<HTMLElement>("[data-word-start]");
    const wordTime = wordEl ? Number(wordEl.dataset.wordStart) : Number.NaN;
    seekTo(part.segment.fileIndex, Number.isFinite(wordTime) ? wordTime : part.segment.start, true);
  }

  function commitLine(segmentIndex: number, newText: string) {
    setEditingIndex(-1);
    if (!canEdit || !corrections) return;
    segmentIndex = shown[segmentIndex]?.sourceSegmentIndex ?? segmentIndex;
    const raw = segments[segmentIndex];
    if (!raw) return;
    const trimmed = newText.replace(/\s+$/g, "");
    const occurrences = occurrencesForLine(segmentIndex, raw.text, trimmed);
    const next = withLineCorrection(corrections, segmentIndex, occurrences);
    try { applyCorrections(segments, next); setEditError(null); }
    catch (e) { setEditError(e instanceof Error ? e.message : "Texten kunde inte rättas."); return; }
    if (JSON.stringify(next.occurrences) !== JSON.stringify(corrections.occurrences)) {
      onCorrectionsChange?.(next);
    }
  }

  function revertLine(segmentIndex: number) {
    setEditingIndex(-1);
    if (!canEdit || !corrections) return;
    onCorrectionsChange?.(withLineCorrection(corrections, shown[segmentIndex]?.sourceSegmentIndex ?? segmentIndex, null));
  }

  /** The passages "Alla N inlägg" moves: this speaker's settled passages, never ones still to check. */
  function sameSpeaker(turn: TranscriptTurn): TranscriptTurn[] {
    if (!turn.speaker) return [turn];
    const settled = turns.filter((t) => t.speaker === turn.speaker && !pendingSpeakerReview(t));
    return settled.includes(turn) ? settled : [turn, ...settled];
  }

  /**
   * Eneo stores who speaks per passage, so a speaker chosen for all of someone's
   * passages is one whole-passage edit for each of them. A passage Eneo asked to
   * check gets a decision instead; "cannot be told" is a decision too. Returns
   * why nothing was saved, or null.
   */
  function reassign(turn: TranscriptTurn, target: string, all: boolean): string | null {
    if (!canEdit || !corrections) return "Talaren kan inte ändras här.";
    let next = corrections;
    try {
      for (const t of all ? sameSpeaker(turn) : [turn]) {
        for (const part of t.parts) {
          const source = part.segment.sourceSegmentIndex ?? part.segmentIndex;
          const stored = segments[source]?.speaker ?? null;
          // A displayed passage can be part of a sentence another speaker shares: only its own span changes.
          const span = sourceSpan(part, segments, next);
          if (pendingSpeakerReview(t) || part.segment.decision || span) {
            next = target === UNRESOLVED
              ? withSpeakerDecision(next, segments, source, span?.from ?? null, span?.to ?? null, "unresolved", null)
              : withSpeakerDecision(next, segments, source, span?.from ?? null, span?.to ?? null, "confirmed", target);
          } else if (stored && target !== UNRESOLVED) {
            next = withSpeakerEdit(next, source, stored, target);
          }
        }
      }
    } catch (e) {
      return e instanceof Error ? e.message : "Talaren kunde inte ändras.";
    }
    // A passage with no speaker of Eneo's has nothing to move: say so rather than save a set that changes nothing.
    if (sameCorrections(next, corrections)) return "Talaren kan inte ändras för det här inlägget.";
    // Eneo refuses a set with more speaker edits than it holds; say so before sending.
    if (next.speaker_edits.length > MAX_SPEAKER_EDITS) {
      return `Det blir fler än ${MAX_SPEAKER_EDITS.toLocaleString("sv-SE")} talarändringar i transkriberingen, mer än Eneo sparar. Ändra färre inlägg åt gången.`;
    }
    setEditError(null);
    onCorrectionsChange?.(next);
    return null;
  }

  // What a passage calls: the same functions on every render, so a press, a letter or a line's editor renders only the
  // passages it changes.
  const startEdit = useSteady((segmentIndex: number) => {
    playback.pause();
    setEditingIndex(segmentIndex);
  });
  const cancelEdit = useSteady(() => setEditingIndex(-1));
  const commitTurnLine = useSteady(commitLine);
  const revertTurnLine = useSteady(revertLine);
  const reassignTurn = useSteady(reassign);
  const renameSpeaker = useSteady((label: string, returnTo: HTMLElement | null) =>
    canName ? namingDialog.current?.open(label, returnTo) : onRenameSpeaker?.(label, returnTo),
  );
  // "Spela från": it plays, also from a pause.
  const seekTurn = useSteady((turn: TranscriptTurn) => seekTo(turn.fileIndex, turn.start, true));
  const clickPart = useSteady(onPartClick);
  const textForEdit = useSteady((index: number) => {
    const source = shown[index]?.sourceSegmentIndex ?? index;
    return correctedSegmentText(segments[source].text, corrections?.occurrences.filter((o) => o.segment_index === source) ?? []);
  });

  if (!hasSegments && !(reviewEnabled && speakerReviews.length)) {
    // Still being read: its shape, not the raw text and a warning that would flash by for a moment.
    if (audioPending) {
      return (
        <section className={join(styles.loading, className)} aria-label="Transkribering" aria-busy="true">
          <VisuallyHidden as="p" role="status">
            Hämtar transkriberingen…
          </VisuallyHidden>
          {[0, 1, 2].map((row) => (
            <HStack key={row} gap={3} vAlign="start">
              <Skeleton width={32} height={32} radius="rounded" />
              <VStack gap={2} className={styles.skeletonLines}>
                <Skeleton width="25%" height={16} />
                <Skeleton width="100%" height={16} />
                <Skeleton width="80%" height={16} />
              </VStack>
            </HStack>
          ))}
        </section>
      );
    }
    return (
      <section className={join(styles.fallback, className)} aria-label="Transkribering">
        <Text as="p" type="supporting">
          Transkriberingen saknar tidsmarkeringar och kan inte följas i ljudet.
        </Text>
        <pre className={styles.fallbackText}>{textFallback}</pre>
      </section>
    );
  }

  const parts: { fileIndex: number; turns: TranscriptTurn[] }[] = [];
  for (const turn of visibleTurns) {
    const last = parts[parts.length - 1];
    if (last && last.fileIndex === turn.fileIndex) last.turns.push(turn);
    else parts.push({ fileIndex: turn.fileIndex, turns: [turn] });
  }
  // The search and the speaker row show on a transcript with segments, while the review's own view is off.
  const tools = !reviewEnabled && hasSegments;
  // The page's actions join the speakers' row, which then needs no row of its own above it: one row less over the text.
  const actionsBySpeakers = actions !== undefined && tools && canName;
  // Naming the speakers after the run: at the end of the speakers' own row above their filter, or on a row of its own
  // above the review's view, which has no filter for the speakers' word to name.
  const namingControl = canName && (
    <SpeakerNaming
      ref={namingDialog}
      naming={naming}
      speakers={speakers}
      shown={shown}
      names={names}
      stepNames={speakerNames}
      corrections={corrections}
      playback={playback}
      hasAudio={hasAudio}
    />
  );
  const saveText = saveState === "saving" ? "Sparar…" : saveState === "saved" ? "Ändringar sparade" : saveState === "error" ? "Kunde inte spara" : "";
  // No count until there is something to look for; then "1 av 3".
  const hitStatus = !searched.trim() ? "" : hits.length === 0 ? "Inga träffar" : `${currentHit + 1} av ${hits.length}`;
  const canDownload = corrections && !correctionProblem;
  const downloadReviewed = () =>
    corrections &&
    downloadBlob(new Blob([renderReviewedTranscript(segments, corrections, speakerNames)], { type: "text/plain;charset=utf-8" }), "granskad-transkribering.txt");
  // The player docked to the text: under it, where the way past the passages ends on it, or above it (PLAYER_ON_TOP). One
  // key in both places, so a tablet turned while it plays moves the same player, and its audio plays on.
  const dockedPlayer = hasAudio && (
    <div
      key="docked-player"
      id={playerOnTop ? undefined : pastId}
      ref={dockRef}
      tabIndex={playerOnTop ? undefined : -1}
      data-docked-player
      data-dock-edge={playerOnTop ? "top" : undefined}
      className={join(styles.dock, playerOnTop && styles.dockTop)}
    >
      <PlayerControls playback={playback} dock={dock} follow={follow} onFollow={() => setFollow(true)} letterKeys={keysSaid ? letterKeys : null} onLetterKeys={turnLetterKeys} />
    </div>
  );

  return (
    <section
      className={join(styles.player, className)}
      role="region"
      aria-label="Inspelning och transkribering"
      tabIndex={0}
      ref={playerRef}
    >
      {title && (
        <HStack hAlign="between" vAlign="center" wrap="wrap" gap={2} paddingInline={3} paddingBlockStart={4} paddingBlockEnd={2} className={styles.inset}>
          <Heading level={2}>{title}</Heading>
          {canDownload && (
            // Its word shown, as the result's "Ladda ner som text": a tooltip, shown on keyboard focus, lay over the
            // speakers under it.
            <Button variant="ghost" size="sm" icon={<Download aria-hidden />} label="Ladda ner granskad transkribering" onClick={downloadReviewed} className={styles.trailing}>
              Ladda ner
            </Button>
          )}
        </HStack>
      )}
      {actions && !actionsBySpeakers && (
        <HStack ref={actionsRow.ref} hAlign="end" vAlign="center" gap={2} paddingInline={3} paddingBlockStart={4} paddingBlockEnd={3} className={styles.inset}>
          {actions(actionsRow.fits)}
        </HStack>
      )}
      {reviewEnabled && namingControl && (
        <HStack hAlign="end" vAlign="center" paddingInline={3} paddingBlockEnd={2} className={join(styles.inset, styles.trailingButton)}>
          {namingControl}
        </HStack>
      )}
      {tools && (
        <VStack gap={3} className={styles.tools}>
          {labelled && (
          <VStack gap={2}>
          {/* Where the speakers can be named, a row of their own above the filter: their word, and the naming at its end,
              with the page's own actions after it where the page gives them. The naming keeps its place in the tree
              whether they are there or not: a tablet turned leaves its dialog, and a correction being written, as they are.
              The last ghost button ends its words on the content's edge. */}
          {canName && (
            <HStack ref={actionsBySpeakers ? actionsRow.ref : undefined} hAlign="between" vAlign="center" wrap="wrap" gap={2}>
              <Text type="label">Talare</Text>
              <HStack gap={2} vAlign="center" className={actionsBySpeakers ? undefined : styles.trailing}>
                {namingControl}
                {actionsBySpeakers && actions?.(actionsRow.fits)}
              </HStack>
            </HStack>
          )}
          {/* The speaker filter: chips that wrap, so none is cut off on a phone. Under the speakers' word the group is
              named by that word, one name to see and to hear (ToggleButtonGroup is named by its label, never by
              aria-labelledby). */}
          <div className={styles.chips} data-many={speakers.length > CHIP_LIMIT || undefined}>
            <ToggleButtonGroup label={canName ? "Talare" : "Visa talare"} type="single" value={shownFilter} onChange={(value) => setFilter(value || "all")}>
              <ToggleButton value="all" label="Alla" />
              {speakers.map((speaker) => (
                <ToggleButton
                  key={speaker.label}
                  value={speaker.label}
                  label={displayName(speaker.label)}
                  icon={<SpeakerMark label={speaker.label} name={displayName(speaker.label)} size="sm" />}
                />
              ))}
              {/* The passages to check are a to-do, set apart from the speakers, so they are counted. */}
              {toCheck > 0 && (
                <>
                  <Divider orientation="vertical" />
                  <ToggleButton value={TO_CHECK} label={`Osäkra (${toCheck})`} icon={<AlertTriangle aria-hidden className={styles.reviewIcon} />} />
                </>
              )}
            </ToggleButtonGroup>
          </div>
          {/* A large meeting on a narrow screen picks one speaker from a list instead of endless chips. In their place under
              the speakers' word, the list is named by that word as they are. */}
          {speakers.length > CHIP_LIMIT && (
            <div className={styles.speakerList}>
              <Selector
                label={canName ? "Talare" : "Filtrera talare"}
                isLabelHidden
                value={shownFilter}
                onChange={setFilter}
                options={[
                  { value: "all", label: "Alla talare" },
                  ...speakers.map((speaker) => ({ value: speaker.label, label: displayName(speaker.label) })),
                  ...(toCheck > 0 ? [{ value: TO_CHECK, label: `Osäkra (${toCheck})` }] : []),
                ]}
              />
            </div>
          )}
          </VStack>
          )}

          <HStack gap={2} vAlign="center">
            <div className={styles.search}>
              <TextInput
                label="Sök i transkriberingen"
                isLabelHidden
                startIcon="search"
                hasClear
                placeholder="Sök i transkriberingen"
                value={query}
                onChange={(next) => {
                  setQuery(next);
                  setHitIndex(0);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  stepHit(e.shiftKey ? -1 : 1);
                }}
              />
            </div>
            {query.trim() && (
              <>
                <Text type="supporting" className={styles.hitCount}>{hitStatus}</Text>
                <IconButton label="Föregående träff" icon={<ChevronUp aria-hidden />} isDisabled={hits.length < 2} onClick={() => stepHit(-1)} />
                <IconButton label="Nästa träff" icon={<ChevronDown aria-hidden />} isDisabled={hits.length < 2} onClick={() => stepHit(1)} />
              </>
            )}
          </HStack>
          {/* The count is said once per change, not per keystroke's markup. */}
          <VisuallyHidden as="p" role="status">{hitStatus && hits.length > 0 ? `Träff ${hitStatus}` : hitStatus}</VisuallyHidden>
        </VStack>
      )}

      {/* Always in the page, so the first save's Sparar… is heard: a live region added with its text often is not. */}
      <VisuallyHidden as="p" role="status">
        {saveText}
      </VisuallyHidden>
      {(audioPending ||
        fileCount === 0 ||
        uncertainWords > 0 ||
        saveState !== "idle") && (
        <div className={styles.status}>
          <div className={styles.statusText}>
            {audioPending && <Text as="p" type="supporting">Hämtar ljud…</Text>}
            {!audioPending && fileCount === 0 && (
              <Text as="p" type="supporting">Ljudet är inte tillgängligt för den här körningen.</Text>
            )}
            {uncertainWords > 0 && (
              <Text as="p" type="supporting">
                {uncertain.remaining > 0 ? (
                  <>
                    <span className={styles.uncertainCount}>
                      {uncertain.remaining} ord
                    </span>{" "}
                    kunde inte hittas i ljudet.
                    {canConfirm
                      ? " Lyssna och bekräfta att de stämmer, eller rätta repliken."
                      : canEdit
                        ? " Rätta repliken om ordet är fel."
                        : fileCount > 0
                          ? " Ett klick på ordet spelar upp det."
                          : ""}
                  </>
                ) : (
                  "Alla osäkra ord är bekräftade."
                )}
                {uncertain.confirmed > 0 && uncertain.remaining > 0 && (
                  <span> {uncertain.confirmed} bekräftade.</span>
                )}
              </Text>
            )}
          </div>
          {saveState !== "idle" && (
            <p className={join(styles.saveState, saveState === "error" && styles.error)}>
              {saveText}
            </p>
          )}
        </div>
      )}

      {correctionProblem && (
        <div className={styles.notice}>
          <Banner status="error" title={correctionProblem} collapsible={false} />
        </div>
      )}
      {editError && (
        <div className={styles.notice}>
          <Banner status="error" title={editError} collapsible={false} />
        </div>
      )}

      {/* The text and its player: the player's sticking stays within the text, never over the tools above. */}
      <div className={styles.body}>
      {/* Above the text, Tab reaches the player before the passages. */}
      {playerOnTop && dockedPlayer}
      {/* Each passage is a few Tab stops, a long meeting hundreds: the way past them, shown when it has focus.
          It moves focus itself, so the address and the history stay the run's. */}
      {/* A plain link: a Button's touch height would outgrow the hidden link and leave a small, invisible target. */}
      <a
        href={`#${pastId}`}
        onClick={(e) => {
          e.preventDefault();
          document.getElementById(pastId)?.focus();
        }}
        className={styles.skipLink}
      >
        Hoppa förbi transkriberingen
      </a>
      {/* Transkribering: on a phone it is part of the page, from a laptop it scrolls inside its card. */}
      <div
        ref={listRef}
        onWheel={onUserScroll}
        onTouchMove={onUserScroll}
        className={join(styles.scrollport, !reviewEnabled && styles.padded)}
      >
        {reviewEnabled ? <ReviewEditorAtPlayhead playback={playback} raw={segments} shown={shown} corrections={corrections} reviews={speakerReviews} labelled={labelled}
          editable={canReview} textEditable={canEdit} onChange={onCorrectionsChange} displayName={displayName} speakerOptions={labelOptions}
          hasAudio={hasAudio} onSeek={(fileIndex, time, autoplay, end) => {
            if (end === undefined) return seekTo(fileIndex, time, autoplay);
            // "Lyssna" on a passage plays it and stops at its end.
            if (hasAudio) setFollow(true);
            playback.playRange(fileIndex, time * 1_000, end * 1_000);
          }}
          confirmedWords={confirmedWords} onToggleConfirmed={onToggleConfirmed}
          onInteract={() => setFollow(false)} /> : parts.map((part) => (
          <div key={part.fileIndex} className={styles.part}>
            {totalFiles > 1 && (
              <h3 className={styles.partHeading}>Del {part.fileIndex + 1}</h3>
            )}
            <ol className={styles.turns} aria-label={totalFiles > 1 ? `Del ${part.fileIndex + 1}` : "Transkriberingen"}>
              {part.turns.map((turn) => {
                // A decision, or a span of a shared sentence, needs Eneo's newer format; a whole passage does not.
                const editableTurn =
                  canEdit &&
                  (pendingSpeakerReview(turn) ||
                  turn.parts.some((p) => p.segment.decision || (corrections && sourceSpan(p, segments, corrections)))
                    ? canDecide
                    : true);
                // A passage is given only what is its own: the line being edited and the hits when they are in it.
                const editingHere = turn.parts.some((part) => part.segmentIndex === editingIndex);
                const hitHere = turn.parts.some((part) => hitsBySegment.has(part.segmentIndex));
                return (
                  <TurnBlock
                    key={turn.index}
                    turn={turn}
                    rawSegments={segments}
                    correctedIndices={correctedIndices}
                    correctedRanges={correctedRanges}
                    hitsBySegment={hitHere ? hitsBySegment : NO_HITS}
                    partLabel={totalFiles > 1 ? ` i del ${turn.fileIndex + 1}` : ""}
                    labelled={labelled}
                    displayName={displayName}
                    labelOptions={labelOptions}
                    samePassages={turn.speaker ? (settledPassages.get(turn.speaker) ?? 0) + (pendingSpeakerReview(turn) ? 1 : 0) : 1}
                    canEdit={canEdit}
                    canPickSpeaker={editableTurn && labelled}
                    textForEdit={textForEdit}
                    confirmedWords={confirmedWords}
                    onToggleConfirmed={onToggleConfirmed}
                    editingIndex={editingHere ? editingIndex : -1}
                    onStartEdit={startEdit}
                    onCancelEdit={cancelEdit}
                    onCommitLine={commitTurnLine}
                    onRevertLine={revertTurnLine}
                    onReassign={reassignTurn}
                    onRename={canName || onRenameSpeaker ? renameSpeaker : undefined}
                    onSeekTurn={seekTurn}
                    onPartClick={clickPart}
                  />
                );
              })}
            </ol>
          </div>
        ))}
        {!reviewEnabled && visibleTurns.length === 0 && (
          <Text as="p" className={styles.empty}>Inga repliker att visa.</Text>
        )}
      </div>

      {hasAudio && !playerOnTop ? (
        // Docked under the text: on a phone it stays in view while the transcript is on screen; on a short screen it
        // would cover most of it, and stays at the end instead.
        dockedPlayer
      ) : (
        // Without a player under the text the way past the passages ends here, and Tab goes on to what follows.
        <span id={pastId} tabIndex={-1} />
      )}
      </div>
    </section>
  );
}

/** One passage. Memoized: the list renders only the passages a change reaches (TranscriptPlayer gives each its own). */
const TurnBlock = memo(function TurnBlock({
  turn,
  rawSegments,
  correctedIndices,
  correctedRanges,
  hitsBySegment,
  partLabel,
  displayName,
  labelOptions,
  labelled,
  samePassages,
  canEdit,
  canPickSpeaker,
  confirmedWords,
  onToggleConfirmed,
  editingIndex,
  onStartEdit,
  onCancelEdit,
  onCommitLine,
  onRevertLine,
  onReassign,
  onRename,
  textForEdit,
  onSeekTurn,
  onPartClick,
}: {
  turn: TranscriptTurn;
  rawSegments: readonly TranscriptSegment[];
  correctedIndices: ReadonlySet<number>;
  correctedRanges: ReadonlyMap<number, CorrectedRange[]>;
  hitsBySegment: ReadonlyMap<number, Hit[]>;
  /** " i del 2" when the recording has parts, so a time says where it is. */
  partLabel: string;
  displayName: (label: string | null) => string;
  labelOptions: readonly string[];
  labelled: boolean;
  /** How many passages "Alla N inlägg" would move. */
  samePassages: number;
  /** The text can be corrected. */
  canEdit: boolean;
  /** Who speaks can be chosen. */
  canPickSpeaker: boolean;
  confirmedWords: ReadonlySet<string>;
  onToggleConfirmed?: (key: string) => void;
  editingIndex: number;
  onStartEdit: (segmentIndex: number) => void;
  onCancelEdit: () => void;
  onCommitLine: (segmentIndex: number, text: string) => void;
  onRevertLine: (segmentIndex: number) => void;
  onReassign: (turn: TranscriptTurn, speaker: string, all: boolean) => string | null;
  /** Opens the naming at a speaker, from the passage's Ändra talare; the focus goes back to `returnTo`. */
  onRename?: (label: string, returnTo: HTMLElement | null) => void;
  textForEdit: (index: number) => string;
  onSeekTurn: (turn: TranscriptTurn) => void;
  onPartClick: (part: TranscriptTurnPart, e: React.MouseEvent) => void;
}) {
  const toCheck = pendingSpeakerReview(turn);
  const decision = turn.parts[0].segment.decision;
  const markLabel = toCheck || decision === "unresolved" ? null : turn.speaker;
  // The passage's own words for who speaks; a passage to check suggests no one.
  const name = effectiveSpeakerLabel(turn.parts[0].segment, displayName);
  const storedSpeaker = rawSegments[turn.parts[0]?.segment.sourceSegmentIndex ?? turn.parts[0]?.segmentIndex ?? -1]?.speaker ?? null;
  const clock = formatClock(turn.start * 1_000);
  // One "Rätta" per passage. In a passage of several sentences it first makes each sentence the target.
  const [choosing, setChoosing] = useState(false);
  const several = turn.parts.length > 1;
  const choosable = canEdit && several && choosing;
  const editingHere = turn.parts.some((part) => part.segmentIndex === editingIndex);
  // Closed from inside (Enter, Esc, Spara, Avbryt), the editor leaves the focus nowhere: it goes back to the passage's
  // Rätta. Left for another control, the focus stays there.
  const correct = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editingHere && (!document.activeElement || document.activeElement === document.body)) correct.current?.focus();
    wasEditing.current = editingHere;
  }, [editingHere]);

  const picker = (trigger: (props: SpeakerPickerTrigger) => React.ReactNode) => (
    <SpeakerPicker
      current={toCheck || decision === "unresolved" ? null : turn.speaker}
      suggested={toCheck ? turn.speaker : null}
      stored={storedSpeaker}
      options={labelOptions}
      displayName={displayName}
      quote={turn.parts.map((p) => p.segment.text).join(" ")}
      passages={samePassages}
      fromName={displayName(turn.speaker)}
      toCheck={toCheck || Boolean(decision)}
      onPick={(speaker, all) => onReassign(turn, speaker, all)}
      onRename={onRename}
    >
      {trigger}
    </SpeakerPicker>
  );

  return (
    <li
      data-turn-index={turn.index}
      aria-label={labelled ? `${name}, ${clock}${partLabel}` : `${clock}${partLabel}`}
      className={styles.turn}
      // The speaker's colour carries over to the passage's name and the rule beside its text (styles/globals.css --tint).
      data-speaker-color={labelled && markLabel ? speakerColorIndex(markLabel) : undefined}
    >
      {labelled && <SpeakerMark label={markLabel} name={displayName(turn.speaker)} />}
      <div className={styles.turnBody}>
        {/* On a touch screen the head's controls are 44 px targets; negative margins keep the row compact. */}
        <div className={styles.head}>
          {labelled && toCheck && <span className={join(styles.name, styles.quiet)}>{name}</span>}
          {labelled && !toCheck &&
            (canPickSpeaker ? (
              picker((trigger) => (
                <button
                  {...trigger}
                  type="button"
                  // The name starts with the words on the button (WCAG 2.5.3) and says what it does.
                  aria-label={`${name}, ändra talare`}
                  className={join(styles.inline, styles.name, styles.speakerName)}
                >
                  {name}
                  <ChevronDown aria-hidden className={styles.chevron} />
                </button>
              ))
            ) : (
              <span className={styles.name}>{name}</span>
            ))}
          <button
            type="button"
            onClick={() => onSeekTurn(turn)}
            aria-label={`Spela från ${clock}${partLabel}`}
            className={join(styles.inline, styles.clock)}
          >
            {clock}
          </button>
          {labelled && toCheck && canPickSpeaker &&
            picker((trigger) => (
              <Button {...trigger} variant="ghost" size="sm" label="Ändra talare" className={styles.changeSpeaker} />
            ))}
          {canEdit && !editingHere && (
            // In the same place on every passage, at the end of its head row, whatever the length of its text; never
            // mid-sentence, and there for mouse and touch alike: an action that appears only under the pointer is one
            // a mouse user never learns exists. Before the sentences it makes the targets while choosing.
            <button
              ref={correct}
              type="button"
              // With the part, as the play button: two parts both start at 0:00.
              aria-label={several ? (choosing ? `Klar med repliken från ${clock}${partLabel}` : `Rätta repliken från ${clock}${partLabel}: välj mening`) : `Rätta repliken från ${clock}${partLabel}`}
              aria-expanded={several ? choosing : undefined}
              onClick={() => (several ? setChoosing(!choosing) : onStartEdit(turn.parts[0].segmentIndex))}
              className={join(styles.inline, styles.correct)}
            >
              {choosing ? <Check aria-hidden strokeWidth={2} /> : <Pencil aria-hidden strokeWidth={2} />}
              {choosing ? "Klar" : "Rätta"}
            </button>
          )}
        </div>
        {choosable && <Text as="p" type="supporting" className={styles.hint}>Välj meningen du vill rätta.</Text>}
        <div className={styles.text}>
          {turn.parts.map((part) => {
            const corrected = correctedIndices.has(part.segmentIndex);
            const ranges = correctedRanges.get(part.segmentIndex) ?? [];
            const partClock = formatClock(part.segment.start * 1_000);
            if (editingIndex === part.segmentIndex) {
              return (
                <LineEditor
                  key={part.segmentIndex}
                  locked={!canEdit}
                  initial={textForEdit(part.segmentIndex)}
                  corrected={corrected}
                  label={`Rätta repliken från ${partClock}${partLabel}`}
                  onCommit={(text) => onCommitLine(part.segmentIndex, text)}
                  onCancel={onCancelEdit}
                  onRevert={() => onRevertLine(part.segmentIndex)}
                />
              );
            }
            const shown = pieces(part.segment, ranges, hitsBySegment.get(part.segmentIndex));
            return (
              <span key={part.segmentIndex}>
                {/* While choosing, the sentence itself is the control. A span, since a button cannot break across
                    lines inside the text; it then holds no other control, so a word is confirmed outside choosing.
                    Its name is the words it shows, then the action (WCAG 2.5.3): the hidden correction notes inside
                    would split the visible words. */}
                <span
                  data-segment-index={part.segmentIndex}
                  onClick={(e) => (choosable ? onStartEdit(part.segmentIndex) : onPartClick(part, e))}
                  {...(choosable && {
                    role: "button",
                    tabIndex: 0,
                    "aria-label": `${shown.map((piece) => piece.text).join("").replace(/\s+/g, " ").trim()} Rätta meningen från ${partClock}${partLabel}.`,
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      onStartEdit(part.segmentIndex);
                    },
                  })}
                  className={join(styles.sentence, choosable && styles.choosable)}
                >
                  {shown.map((piece, k, all) => {
                    const key = piece.word ? wordKey(part.segment.sourceSegmentIndex ?? part.segmentIndex, piece.word) : null;
                    const confirmed = key !== null && confirmedWords.has(key);
                    const flagged = Boolean(piece.word?.uncertain) && !confirmed;
                    // The confirm button sits after the word's last piece.
                    const lastOfWord =
                      Boolean(piece.word?.uncertain) &&
                      all[k + 1]?.wordIndex !== piece.wordIndex;
                    const Word = piece.hit ? "mark" : "span";
                    // A piece is its one element (and a word's confirm button after it), no wrapper: an hour's meeting
                    // is tens of thousands of pieces, and a wrapper each doubled the page's elements.
                    return (
                      <Fragment key={k}>
                        <Word
                          data-word-start={piece.word ? piece.word.start : undefined}
                          data-word-index={piece.word ? piece.wordIndex : undefined}
                          data-hit={piece.hit ?? undefined}
                          className={join(
                            styles.word,
                            flagged && styles.flagged,
                            confirmed && styles.confirmed,
                            piece.hit === "match" && styles.match,
                            piece.hit === "current" && styles.currentMatch,
                            piece.correctedFrom !== null && styles.corrected,
                          )}
                          title={
                            piece.correctedFrom !== null
                              ? `Rättad från: ${piece.correctedFrom}`
                              : flagged
                                ? onToggleConfirmed
                                  ? "Ordet kunde inte hittas i ljudet. Lyssna och bekräfta, eller rätta repliken."
                                  : "Ordet kunde inte hittas i ljudet."
                                : confirmed
                                  ? "Bekräftat: ordet stämmer."
                                  : undefined
                          }
                        >
                          {piece.text}
                          {piece.correctedFrom !== null && <VisuallyHidden data-correction-note> (rättad från {piece.correctedFrom})</VisuallyHidden>}
                        </Word>
                        {lastOfWord && onToggleConfirmed && key !== null && !choosable && (
                          <button
                            type="button"
                            className={styles.confirmButton}
                            onClick={(e) => {
                              e.stopPropagation();
                              onToggleConfirmed(key);
                            }}
                            aria-pressed={confirmed}
                            aria-label={
                              confirmed
                                ? `Ångra bekräftelse av ”${piece.word?.word}”`
                                : `Bekräfta att ”${piece.word?.word}” stämmer`
                            }
                            title={confirmed ? "Bekräftat – välj igen för att ångra" : "Ordet stämmer"}
                          >
                            <span aria-hidden className={join(styles.confirmMark, confirmed && styles.confirmMarkDone)}>
                              <Check strokeWidth={3} />
                            </span>
                          </button>
                        )}
                      </Fragment>
                    );
                  })}
                </span>
                {" "}
              </span>
            );
          })}
        </div>
      </div>
    </li>
  );
});

/**
 * "Ändra talare": which of the run's speakers says this passage. It changes
 * this passage unless the user widens it to all of the speaker's passages (the
 * merge, when diarization split one person in two). A passage Eneo asks to
 * check starts with "Det stämmer" and ends with "Går inte att avgöra".
 */
function SpeakerPicker({
  current,
  suggested,
  stored,
  options,
  displayName,
  quote,
  passages,
  fromName,
  toCheck,
  onPick,
  onRename,
  children,
}: {
  /** The passage's settled speaker; null while it is to be checked or cannot be told. */
  current: string | null;
  /** The speaker Eneo put on a passage to check. */
  suggested: string | null;
  stored: string | null;
  options: readonly string[];
  displayName: (label: string | null) => string;
  quote: string;
  passages: number;
  /** Whose passages "Alla" moves, as people read it. */
  fromName: string;
  toCheck: boolean;
  /** Saves the choice; returns why it was not saved, or null. */
  onPick: (speaker: string, all: boolean) => string | null;
  /** Names the passage's speaker instead ("Byt namn på"), once this has closed and given the focus back to its button. */
  onRename?: (label: string, returnTo: HTMLElement | null) => void;
  /** The button that opens it: the design system's own props for it go on the button. */
  children: (trigger: SpeakerPickerTrigger) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<string>(current ?? "");
  const [scope, setScope] = useState<"one" | "all">("one");
  const [problem, setProblem] = useState<string | null>(null);
  const others = suggested ? options.filter((label) => label !== suggested) : options;
  const trigger = useRef<HTMLButtonElement>(null);
  const dialogId = useId();
  const covered = useSignedOut();
  const wasOpen = useRef(false);
  // The speaker "Byt namn på" names: the naming opens once this dialog has closed, so the focus returns to this button.
  const renaming = useRef<string | null>(null);
  useEffect(() => {
    if (wasOpen.current && !open) {
      trigger.current?.focus({ preventScroll: true });
      if (renaming.current) onRename?.(renaming.current, trigger.current);
      renaming.current = null;
    }
    wasOpen.current = open;
  }, [open]);
  const close = () => setOpen(false);
  const submit = () => {
    if (!choice) return;
    const refused = onPick(choice, choice !== UNRESOLVED && scope === "all" && passages > 1);
    setProblem(refused);
    if (!refused) close();
  };

  return (
    <>
      {children({
        ref: trigger,
        "aria-haspopup": "dialog",
        "aria-expanded": open,
        "aria-controls": dialogId,
        onClick: () => {
          setChoice(current ?? "");
          setScope("one");
          setProblem(null);
          setOpen(true);
        },
      })}
      <Dialog
        id={dialogId}
        aria-label="Ändra talare"
        isOpen={open && !covered}
        onOpenChange={(next) => !next && close()}
        width="22rem"
        maxHeight="calc(100dvh - 2 * var(--spacing-4))"
        purpose="form"
      >
        {/* A long meeting has hundreds of passages; only the open dialog needs its controls. */}
        {open && (
          <Layout
            header={<DialogHeader title="Ändra talare" onOpenChange={close} />}
            content={
              <LayoutContent padding={0}>
                <div className={styles.pickerHead}>
                  <Text as="p" type="supporting" maxLines={2} hasTruncateTooltip={false}>”{quote}”</Text>
                </div>
                <div className={styles.pickerList}>
                  <RadioList label="Vem talar?" value={choice} onChange={setChoice}>
                    {suggested && (
                      <PickerOption value={suggested} label={suggested} name={`Det stämmer: ${displayName(suggested)}`} markName={displayName(suggested)} />
                    )}
                    {others.map((label) => (
                      <PickerOption
                        key={label}
                        value={label}
                        label={label}
                        name={displayName(label)}
                        note={label === stored && !toCheck ? "ursprunglig" : undefined}
                      />
                    ))}
                    {toCheck && <PickerOption value={UNRESOLVED} label={null} name="Går inte att avgöra" />}
                  </RadioList>
                </div>
                {passages > 1 && choice !== UNRESOLVED && (
                  <div className={styles.pickerSection}>
                    <RadioList label="Gäller" value={scope} onChange={(value) => setScope(value as "one" | "all")}>
                      <RadioListItem value="one" label="Bara det här inlägget" />
                      <RadioListItem value="all" label={`Alla ${passages} inlägg från ${fromName}`} />
                    </RadioList>
                  </div>
                )}
                {/* Or the speaker is right and only unnamed: after the choice and its scope, which belong together. */}
                {onRename && current && (
                  <div className={styles.pickerSection}>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Pencil aria-hidden />}
                      label={`Byt namn på ${displayName(current)}`}
                      aria-haspopup="dialog"
                      className={styles.rename}
                      onClick={() => {
                        renaming.current = current;
                        close();
                      }}
                    />
                  </div>
                )}
                {problem && (
                  <div className={styles.pickerSection}>
                    <Banner status="error" title={problem} collapsible={false} />
                  </div>
                )}
              </LayoutContent>
            }
            footer={
              <LayoutFooter hasDivider>
                <ActionRow>
                  <Button variant="ghost" label="Avbryt" onClick={close} />
                  <Button variant="primary" label="Spara" isDisabled={!choice || choice === current} onClick={submit} />
                </ActionRow>
              </LayoutFooter>
            }
          />
        )}
      </Dialog>
    </>
  );
}

/**
 * "Namnge talare" after the run: the naming dialog with a row for each speaker the transcript shows, a split one too,
 * their passages and first words, a sample through the page's player, and the names in use to choose from. A save hands
 * the names over the naming step's (namesAfterNaming) to the page's save, which lays them on the corrections as they are
 * then and sends nothing for what Eneo has already.
 */
function SpeakerNaming({
  ref,
  naming,
  speakers,
  shown,
  names,
  stepNames,
  corrections,
  playback,
  hasAudio,
}: {
  ref: Ref<SpeakerNamingHandle>;
  naming: Naming;
  speakers: readonly { label: string; passages: number }[];
  /** The passages as shown, with the corrections. */
  shown: readonly TranscriptSegment[];
  /** The names the page shows. */
  names: Readonly<Record<string, string>>;
  /** A naming step's names, which the names given after the run are laid over. */
  stepNames: Readonly<Record<string, string>>;
  corrections: CorrectionSet;
  playback: Playback;
  hasAudio: boolean;
}) {
  // The speaker whose sample was asked for; it plays while the playback does.
  const [sample, setSample] = useState<string | null>(null);
  const sounds = useSyncExternalStore(
    playback.subscribe,
    () => playback.getSnapshot().playing || playback.getSnapshot().starting,
    () => false,
  );
  const listening = sounds ? sample : null;
  const rows = useMemo<SpeakerMappingRow[]>(
    () => speakers.map((speaker) => ({ label: speaker.label, lineCount: speaker.passages, samples: [], name: names[speaker.label] ?? null, confidence: "low", evidence: "" })),
    [speakers, names],
  );

  // A sample: the speaker's first passage, at most eight seconds, as the review's naming plays it.
  function listenTo(label: string) {
    const target = firstSegmentForSpeaker(shown, label);
    if (!target) return;
    setSample(label);
    playback.playRange(target.fileIndex, target.time * 1_000, Math.min(shown[target.segmentIndex].end, target.time + 8) * 1_000);
  }
  function stopListening() {
    if (listening) playback.pause();
    setSample(null);
  }
  function save(typed: SpeakerMappingRow[]): Promise<string | null> {
    return naming.save(namesAfterNaming(typed, stepNames, corrections.speakerNames));
  }

  return (
    <SpeakerNamingDialog
      ref={ref}
      rows={rows}
      participants={[...new Set([...naming.participants, ...Object.values(names)])]}
      passages={(label) => speakers.find((speaker) => speaker.label === label)?.passages ?? 0}
      quote={(label) => shown.find((segment) => segment.speaker === label)?.text ?? null}
      onListen={hasAudio ? listenTo : undefined}
      listening={listening}
      onStopListening={stopListening}
      listenUnavailableReason={(label) => (firstSegmentForSpeaker(shown, label) ? null : "Det finns inget tilldelat exempel utan överlappande tal.")}
      onSave={save}
      draftKey={naming.draftKey}
      description={naming.description}
    >
      <Button variant="ghost" size="sm" icon={<UsersRound aria-hidden />} label="Namnge talare" />
    </SpeakerNamingDialog>
  );
}

function PickerOption({ value, label, name, markName = name, note }: { value: string; label: string | null; name: string; markName?: string; note?: string }) {
  return (
    <RadioListItem
      value={value}
      label={
        <HStack as="span" gap={2} align="center">
          <SpeakerMark label={label} name={markName} size="sm" />
          {name}
        </HStack>
      }
      description={note}
    />
  );
}

function LineEditor({
  locked,
  initial,
  corrected,
  label,
  onCommit,
  onCancel,
  onRevert,
}: {
  /** Correcting ended while the editor was open (the review was approved): what was typed stays to copy, unsaved. */
  locked: boolean;
  initial: string;
  corrected: boolean;
  label: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
  onRevert: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fit = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    fit(el);
  }, []);
  return (
    <VStack
      className={styles.lineEditor}
      gap={3}
      // Focus moving between the text and its buttons stays in the editor; leaving it all saves or closes.
      onBlur={(e) => {
        if (locked || e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        if (value !== initial) onCommit(value);
        else onCancel();
      }}
    >
      <TextArea
        ref={ref}
        label={label}
        isLabelHidden
        value={value}
        rows={1}
        isReadOnly={locked}
        onChange={(next, e) => {
          setValue(next);
          fit(e.target);
        }}
        onKeyDown={(e) => {
          if (locked) {
            if (e.key === "Escape") onCancel();
            return;
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onCommit(value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      {locked ? (
        <HStack gap={3} wrap="wrap" vAlign="center">
          <Text type="supporting">Rättningen kan inte sparas längre. Kopiera texten om du vill behålla den.</Text>
          <Button size="sm" variant="ghost" label="Stäng" onClick={onCancel} />
        </HStack>
      ) : (
        <HStack gap={3} wrap="wrap" vAlign="center">
          {/* Pressed without taking the focus, so leaving the field does not save first. */}
          <Button size="sm" variant="ghost" label="Avbryt" onMouseDown={(e) => e.preventDefault()} onClick={onCancel} />
          <Button size="sm" variant="primary" label="Spara" onMouseDown={(e) => e.preventDefault()} onClick={() => onCommit(value)} />
          <Text type="supporting" className={styles.keysHint}>Enter sparar · Esc avbryter</Text>
          {corrected && (
            <Button size="sm" variant="ghost" label="Återställ originalet" onMouseDown={(e) => e.preventDefault()} onClick={onRevert} />
          )}
        </HStack>
      )}
    </VStack>
  );
}
