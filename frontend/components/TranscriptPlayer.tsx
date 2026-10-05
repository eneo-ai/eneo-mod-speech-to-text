import { AlertTriangle, Check, ChevronDown, ChevronUp, Download, Pencil, RotateCcw, RotateCw } from "lucide-react";
import {
  type ComponentProps,
  type ComponentType,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { HStack } from "@astryxdesign/core/HStack";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Popover, type PopoverTriggerRenderProps } from "@astryxdesign/core/Popover";
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
import { AudioPlayer, usePlayback, usePlaybackState } from "@/components/flow/AudioPlayer";
import styles from "@/components/TranscriptPlayer.module.css";
import { useDock } from "@/lib/dock";
import { downloadBlob } from "@/lib/download";
import { scrollBehavior } from "@/lib/motion";
import { LoadFailure } from "@/components/LoadFailure";
import { lazyLoader, useLoaded } from "@/lib/lazy-component";
import { formatClock } from "@/lib/format";
import type { Playback, PlayerSource } from "@/lib/playback";
import { SPEAKER_REVIEW_ENABLED, type FileSpeakerReview } from "@/lib/speaker-review";
import { countUncertain, wordKey } from "@/lib/confirmed-words";
import {
  computeTurns,
  countFiles,
  effectiveSpeakerLabel,
  findActiveSegmentIndex,
  findActiveSegmentIndices,
  findActiveWordIndex,
  findHits,
  paragraphTurns,
  pendingSpeakerReview,
  speakerColorIndex,
  speakerName,
  speakerInitial,
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
  MAX_SPEAKER_EDITS,
  renderReviewedTranscript,
  sameCorrections,
  type CorrectedRange,
  type CorrectionSet,
} from "@/lib/transcript-corrections";

export type CorrectionsSaveState = "idle" | "saving" | "saved" | "error";

const RATES = [0.75, 1, 1.25, 1.5, 2];
const NO_SOURCES: readonly PlayerSource[] = [];
const EMPTY_SET: ReadonlySet<string> = new Set();
const SKIP_SECONDS = 10;
/** The picker's value for "the speaker cannot be told". */
const UNRESOLVED = "__unresolved";
/** The filter value for the passages Eneo asks someone to check: a to-do, not a speaker. */
const TO_CHECK = "__check";
/** Above this many speakers a phone picks one from a list instead of scrolling chips. */
const CHIP_LIMIT = 5;

/**
 * The transcript's keys, outside its controls and text: Space or K plays and
 * pauses, the arrow keys move five seconds, J and L ten. `skipMs` 0 toggles.
 */
export function shortcut(key: string): { skipMs: number; preventDefault: boolean } | null {
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

function rateLabel(rate: number): string {
  return `${String(rate).replace(".", ",")}×`;
}

type EditorProps = ComponentProps<typeof TranscriptEditor>;

// The editor is the review's largest part, shown only where its setting is on: its code loads when it is first shown (a
// page that never shows it never loads it), and is kept for the next. Until it has arrived a placeholder holds its place.
const editor = lazyLoader<ComponentType<EditorProps>>(() => import("@/components/TranscriptEditor").then((module) => module.TranscriptEditor));
/** Loads the editor ahead of its being shown: a test that renders it as markup waits for this first. */
export const preloadTranscriptEditor = () => editor.load();

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

/** A speaker's round mark: the initial on the speaker's colour, the same everywhere on the page. */
export function SpeakerMark({ label, name, size = "md" }: { label: string | null; name: string; size?: "sm" | "md" | "lg" }) {
  return (
    <span aria-hidden className={styles.mark} data-size={size} data-speaker-color={label ? speakerColorIndex(label) : undefined}>
      {label ? speakerInitial(name) : "?"}
    </span>
  );
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
    downloadable = true,
    playback: shared,
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
    /** Its own link to download the reviewed transcript; off when the page has actions of its own. */
    downloadable?: boolean;
    /**
     * The page's own playback of these parts, when the page shows it elsewhere too
     * (a pause control beside the document); otherwise the transcript owns one.
     */
    playback?: Playback;
  },
) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const programmaticScrollUntil = useRef(0);
  const pastId = useId();

  const [follow, setFollow] = useState(true);
  const [dock, dockRef] = useDock();
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
  const position = usePlaybackState(playback);
  const currentFile = position.part;
  const currentTime = position.withinMs / 1_000;
  const paused = !position.playing;
  const audioUnavailable = position.unavailable;
  const rate = position.rate;

  const applied = useMemo(() => applyCorrections(segments, corrections), [segments, corrections]);
  const shown = applied.segments;
  // Nothing is lit until playback has started or been moved.
  const playhead = position.started ? currentTime : Number.NEGATIVE_INFINITY;
  const activeIndices = new Set(findActiveSegmentIndices(shown, currentFile, playhead));
  // A flow without speaker labels names no speaker: "Okänd talare" on every block would mislead.
  const labelled = shown.some((segment) => segment.speaker !== null) || speakerReviews.length > 0;
  // Scrolling follows only once playback has started or been moved.
  const activeIndex = position.started ? findActiveSegmentIndex(shown, currentFile, currentTime) : -1;
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

  const displayName = useCallback(
    (label: string | null) => {
      if (!label) return "Okänd talare";
      return speakerName(label, speakerNames);
    },
    [speakerNames],
  );

  const labelOptions = useMemo(() => {
    const set = new Set<string>(speakerOptions ?? []);
    for (const s of segments) if (s.speaker) set.add(s.speaker);
    for (const e of corrections?.speaker_edits ?? []) if (e.speaker) set.add(e.speaker);
    return [...set].sort();
  }, [speakerOptions, segments, corrections]);

  // A filter whose speaker is gone (all their passages moved) shows everyone again.
  const toCheck = turns.filter(pendingSpeakerReview).length;
  const shownFilter =
    filter === TO_CHECK ? (toCheck > 0 ? TO_CHECK : "all") : speakers.some((s) => s.label === filter) ? filter : "all";
  const visibleTurns =
    shownFilter === "all"
      ? turns
      : shownFilter === TO_CHECK
        ? turns.filter(pendingSpeakerReview)
        : turns.filter((turn) => turn.speaker === shownFilter && !pendingSpeakerReview(turn));
  const visibleSegments = useMemo(
    () => new Set(visibleTurns.flatMap((turn) => turn.parts.map((part) => part.segmentIndex))),
    [visibleTurns],
  );
  const hits = useMemo(
    () => findHits(shown, query).filter((hit) => visibleSegments.has(hit.segmentIndex)),
    [shown, query, visibleSegments],
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

  function cycleRate() {
    playback.setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length]);
  }

  function skipFromControl(milliseconds: number, trigger: HTMLElement) {
    playback.skip(milliseconds);
    const next = playback.getSnapshot();
    // The pressed control becomes disabled at a boundary. Keep keyboard focus in the player, on its position.
    if (document.activeElement === trigger && (next.atMs === 0 || next.atEnd)) {
      dock?.querySelector<HTMLElement>('[role="slider"]')?.focus();
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    const action = shortcut(e.key);
    if (!action) return;
    const target = e.target as HTMLElement;
    // The position slider moves by its own keys; controls and text fields keep theirs.
    if (target.closest("button, a, input, select, textarea, [role=button], [role=slider], [role=menuitemradio], [role=radio], [contenteditable]")) return;
    if (!hasAudio || audioUnavailable) return;
    if (action.preventDefault) e.preventDefault();
    if (action.skipMs === 0) playback.toggle();
    else playback.skip(action.skipMs);
  }

  useEffect(() => {
    if (!follow || activeIndex < 0 || !listRef.current || editingIndex >= 0) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-segment-index="${activeIndex}"]`,
    );
    const block = el?.closest<HTMLElement>("[data-turn-index]") ?? el;
    if (!block) return;
    programmaticScrollUntil.current = Date.now() + 800;
    block.scrollIntoView({ block: "center", behavior: scrollBehavior() });
  }, [activeIndex, follow, editingIndex]);

  // The search's current hit is brought into view, and playback stops pulling the text away from it.
  useEffect(() => {
    if (currentHit < 0 || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>('[data-hit="current"]');
    if (!el) return;
    programmaticScrollUntil.current = Date.now() + 800;
    setFollow(false);
    el.scrollIntoView({ block: "center", behavior: scrollBehavior() });
  }, [currentHit, query]);

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
    const wordEl = (e.target as HTMLElement).closest<HTMLElement>("[data-word-start]");
    const wordTime = wordEl ? Number(wordEl.dataset.wordStart) : Number.NaN;
    seekTo(
      part.segment.fileIndex,
      Number.isFinite(wordTime) ? wordTime : part.segment.start,
      !paused,
    );
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
  const saveText = saveState === "saving" ? "Sparar…" : saveState === "saved" ? "Rättningar sparade" : saveState === "error" ? "Kunde inte spara" : "";
  // No count until there is something to look for; then "1 av 3".
  const hitStatus = !query.trim() ? "" : hits.length === 0 ? "Inga träffar" : `${currentHit + 1} av ${hits.length}`;

  return (
    <section
      className={join(styles.player, className)}
      role="region"
      aria-label="Inspelning och transkribering"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {tools && (
        <VStack gap={3} className={styles.tools}>
          {labelled && (<>
          {/* The speaker filter, nothing else: chips that wrap, so none is cut off on a phone. */}
          <div className={styles.chips} data-many={speakers.length > CHIP_LIMIT || undefined}>
            <ToggleButtonGroup label="Visa talare" type="single" size="sm" value={shownFilter} onChange={(value) => setFilter(value || "all")}>
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
          {/* A large meeting on a narrow screen picks one speaker from a list instead of endless chips. */}
          {speakers.length > CHIP_LIMIT && (
            <div className={styles.speakerList}>
              <Selector
                label="Filtrera talare"
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
          </>)}

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
      {downloadable && corrections && !correctionProblem && (
        <Button
          variant="ghost"
          size="sm"
          icon={<Download aria-hidden />}
          label="Hämta granskad transkribering"
          className={styles.download}
          onClick={() => downloadBlob(new Blob([renderReviewedTranscript(segments, corrections, speakerNames)], { type: "text/plain;charset=utf-8" }), "granskad-transkribering.txt")}
        />
      )}

      {/* The text and its player: the player's sticking stays within the text, never over the tools above. */}
      <div className={styles.body}>
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
        {reviewEnabled ? <LazyTranscriptEditor raw={segments} shown={shown} corrections={corrections} reviews={speakerReviews} labelled={labelled}
          editable={canReview} textEditable={canEdit} onChange={onCorrectionsChange} displayName={displayName} speakerOptions={labelOptions}
          audioAvailable={hasAudio && !audioUnavailable} currentFile={currentFile} currentTime={playhead} playing={!paused} onSeek={(fileIndex, time, autoplay, end) => {
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
                return (
                  <TurnBlock
                    key={turn.index}
                    turn={turn}
                    rawSegments={segments}
                    correctedIndices={correctedIndices}
                    correctedRanges={correctedRanges}
                    hitsBySegment={hitsBySegment}
                    partLabel={totalFiles > 1 ? ` i del ${turn.fileIndex + 1}` : ""}
                    activeIndices={activeIndices}
                    currentTime={playhead}
                    labelled={labelled}
                    displayName={displayName}
                    labelOptions={labelOptions}
                    samePassages={turn.speaker ? (settledPassages.get(turn.speaker) ?? 0) + (pendingSpeakerReview(turn) ? 1 : 0) : 1}
                    canEdit={canEdit}
                    canPickSpeaker={editableTurn && labelled}
                    textForEdit={(index) => {
                      const source = shown[index]?.sourceSegmentIndex ?? index;
                      return correctedSegmentText(segments[source].text, corrections?.occurrences.filter((o) => o.segment_index === source) ?? []);
                    }}
                    confirmedWords={confirmedWords}
                    onToggleConfirmed={onToggleConfirmed}
                    editingIndex={editingIndex}
                    onStartEdit={(idx) => {
                      playback.pause();
                      setEditingIndex(idx);
                    }}
                    onCancelEdit={() => setEditingIndex(-1)}
                    onCommitLine={commitLine}
                    onRevertLine={revertLine}
                    onReassign={(speaker, all) => reassign(turn, speaker, all)}
                    // "Spela från": it plays, also from a pause.
                    onSeekTurn={() => seekTo(turn.fileIndex, turn.start, true)}
                    onPartClick={onPartClick}
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

      {hasAudio ? (
        // Docked under the text: on a phone it stays in view while the transcript is on screen; on a short screen it
        // would cover most of it, and stays at the end instead.
        <div id={pastId} ref={dockRef} tabIndex={-1} data-docked-player className={styles.dock}>
          {/* Above the player's row: in it, on a phone, they would leave the position slider a few pixels. Speed sits in the
              row from 640 px (below it the copy here is shown, and the one in the row is not). */}
          <div className={styles.dockTools}>
            {!follow && <Button variant="ghost" size="sm" label="Följ" onClick={() => setFollow(true)} />}
            <Button variant="ghost" size="sm" label={`Hastighet ${rateLabel(rate)}`} className={styles.rateBelow} onClick={cycleRate}>
              {rateLabel(rate)}
            </Button>
          </div>
          {/* Beside the controls it is about, and announced: the press that asked for the audio is answered here. */}
          {audioUnavailable && (
            <p role="alert" className={styles.error}>
              Ljudet kunde inte spelas.{" "}
              <Button variant="ghost" size="sm" label="Försök igen" onClick={() => playback.reload()} />
            </p>
          )}
          <AudioPlayer playback={playback} label="Inspelningen">
            <IconButton
              variant="ghost"
              className={styles.skip}
              isDisabled={audioUnavailable || position.atMs === 0}
              label={`Bakåt ${SKIP_SECONDS} sekunder`}
              icon={<RotateCcw aria-hidden />}
              onClick={(event) => skipFromControl(-SKIP_SECONDS * 1_000, event.currentTarget)}
            />
            <IconButton
              variant="ghost"
              className={styles.skip}
              isDisabled={audioUnavailable || position.atEnd}
              label={`Framåt ${SKIP_SECONDS} sekunder`}
              icon={<RotateCw aria-hidden />}
              onClick={(event) => skipFromControl(SKIP_SECONDS * 1_000, event.currentTarget)}
            />
            <Button variant="ghost" size="sm" label={`Hastighet ${rateLabel(rate)}`} className={styles.rate} onClick={cycleRate}>
              {rateLabel(rate)}
            </Button>
          </AudioPlayer>
        </div>
      ) : (
        // Without a player the way past the passages ends here, and Tab goes on to what follows the transcript.
        <span id={pastId} tabIndex={-1} />
      )}
      </div>
    </section>
  );
}

function TurnBlock({
  turn,
  rawSegments,
  correctedIndices,
  correctedRanges,
  hitsBySegment,
  partLabel,
  activeIndices,
  currentTime,
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
  activeIndices: ReadonlySet<number>;
  currentTime: number;
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
  onReassign: (speaker: string, all: boolean) => string | null;
  textForEdit: (index: number) => string;
  onSeekTurn: () => void;
  onPartClick: (part: TranscriptTurnPart, e: React.MouseEvent) => void;
}) {
  const toCheck = pendingSpeakerReview(turn);
  const decision = turn.parts[0].segment.decision;
  const markLabel = toCheck || decision === "unresolved" ? null : turn.speaker;
  // The passage's own words for who speaks; a passage to check suggests no one.
  const name = effectiveSpeakerLabel(turn.parts[0].segment, displayName);
  const isActive = turn.parts.some((p) => activeIndices.has(p.segmentIndex));
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

  const picker = (trigger: (props: PopoverTriggerRenderProps) => React.ReactNode) => (
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
      onPick={onReassign}
    >
      {trigger}
    </SpeakerPicker>
  );

  return (
    <li
      data-turn-index={turn.index}
      data-active={isActive}
      aria-label={labelled ? `${name}, ${clock}${partLabel}` : `${clock}${partLabel}`}
      className={styles.turn}
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
            onClick={onSeekTurn}
            aria-label={`Spela från ${clock}${partLabel}`}
            className={join(styles.inline, styles.clock)}
          >
            {clock}
          </button>
          {labelled && toCheck && canPickSpeaker &&
            picker((trigger) => (
              <Button {...trigger} variant="ghost" size="sm" label="Ändra talare" className={styles.changeSpeaker} />
            ))}
        </div>
        {choosable && <Text as="p" type="supporting" className={styles.hint}>Välj meningen du vill rätta.</Text>}
        <div className={styles.text}>
          {turn.parts.map((part) => {
            const partActive = activeIndices.has(part.segmentIndex);
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
                  className={join(styles.sentence, partActive && styles.sentenceActive, choosable && styles.choosable)}
                >
                  {shown.map((piece, k, all) => {
                    const key = piece.word ? wordKey(part.segment.sourceSegmentIndex ?? part.segmentIndex, piece.word) : null;
                    const confirmed = key !== null && confirmedWords.has(key);
                    const flagged = Boolean(piece.word?.uncertain) && !confirmed;
                    const isWordActive =
                      Boolean(piece.word) && partActive && piece.wordIndex === findActiveWordIndex(part.segment.words ?? [], currentTime);
                    // The confirm button sits after the word's last piece.
                    const lastOfWord =
                      Boolean(piece.word?.uncertain) &&
                      all[k + 1]?.wordIndex !== piece.wordIndex;
                    const Word = piece.hit ? "mark" : "span";
                    return (
                      <span key={k}>
                        <Word
                          data-word-start={piece.word ? piece.word.start : undefined}
                          aria-current={isWordActive ? "true" : undefined}
                          data-hit={piece.hit ?? undefined}
                          className={join(
                            styles.word,
                            flagged && styles.flagged,
                            confirmed && styles.confirmed,
                            piece.hit === "match" && styles.match,
                            piece.hit === "current" && styles.currentMatch,
                            isWordActive && styles.lit,
                            piece.correctedFrom !== null && styles.corrected,
                          )}
                          title={
                            piece.correctedFrom !== null
                              ? `Rättad från: ${piece.correctedFrom}`
                              : flagged
                                ? "Ordet kunde inte hittas i ljudet. Lyssna och bekräfta, eller rätta repliken."
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
                                ? `Ångra bekräftelse av "${piece.word?.word}"`
                                : `Bekräfta att "${piece.word?.word}" stämmer`
                            }
                            title={confirmed ? "Bekräftat – välj igen för att ångra" : "Ordet stämmer"}
                          >
                            <span aria-hidden className={join(styles.confirmMark, confirmed && styles.confirmMarkDone)}>
                              <Check strokeWidth={3} />
                            </span>
                          </button>
                        )}
                      </span>
                    );
                  })}
                </span>
                {" "}
              </span>
            );
          })}
          {canEdit && !editingHere && (
            // After the passage, never mid-sentence, and on every passage for mouse and touch alike: an action
            // that appears only under the pointer is one a mouse user never learns exists.
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
      </div>
    </li>
  );
}

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
  /** The button that opens it: the design system's own props for it go on the button. */
  children: (trigger: PopoverTriggerRenderProps) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<string>(current ?? "");
  const [scope, setScope] = useState<"one" | "all">("one");
  const [problem, setProblem] = useState<string | null>(null);
  const others = suggested ? options.filter((label) => label !== suggested) : options;

  return (
    <Popover
      isOpen={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          // Every opening starts from this passage alone; all of a speaker's passages is a deliberate choice.
          setChoice(current ?? "");
          setScope("one");
          setProblem(null);
        }
      }}
      label="Ändra talare"
      width="22rem"
      placement="below"
      alignment="start"
      isModal={false}
      hasCloseButton={false}
      content={
        // Only while it is open: a long meeting has hundreds of passages, none of them with a form of its own in the page.
        open ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!choice) return;
              const refused = onPick(choice, choice !== UNRESOLVED && scope === "all" && passages > 1);
              setProblem(refused);
              if (!refused) setOpen(false);
            }}
          >
            <div className={styles.pickerHead}>
              <Text as="p" weight="semibold">Ändra talare</Text>
              <Text as="p" type="supporting" maxLines={2} hasTruncateTooltip={false}>{quote}</Text>
            </div>
            <div className={styles.pickerList}>
              <RadioList label="Ändra talare" isLabelHidden value={choice} onChange={setChoice}>
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
            {problem && (
              <div className={styles.pickerSection}>
                <Banner status="error" title={problem} collapsible={false} />
              </div>
            )}
            <HStack gap={2} hAlign="end" className={styles.pickerSection}>
              <Button variant="ghost" size="sm" label="Avbryt" onClick={() => setOpen(false)} />
              <Button type="submit" variant="primary" size="sm" label="Spara" isDisabled={!choice || choice === current} />
            </HStack>
          </form>
        ) : null
      }
    >
      {children}
    </Popover>
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
          <Button size="sm" variant="primary" label="Spara" onMouseDown={(e) => e.preventDefault()} onClick={() => onCommit(value)} />
          <Button size="sm" variant="ghost" label="Avbryt" onMouseDown={(e) => e.preventDefault()} onClick={onCancel} />
          <Text type="supporting" className={styles.keysHint}>Enter sparar · Esc avbryter</Text>
          {corrected && (
            <Button size="sm" variant="ghost" label="Återställ originalet" onMouseDown={(e) => e.preventDefault()} onClick={onRevert} />
          )}
        </HStack>
      )}
    </VStack>
  );
}
