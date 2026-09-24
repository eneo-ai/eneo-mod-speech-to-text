"use client";

import { AlertTriangle, Check, ChevronDown, ChevronUp, Download, Pencil, RotateCcw, RotateCw, Search } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { TranscriptEditor } from "@/components/TranscriptEditor";
import { AudioPlayer, usePlayback, usePlaybackState } from "@/components/flow/AudioPlayer";
import { formatClock } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Playback, PlayerSource } from "@/lib/playback";
import { SPEAKER_REVIEW_ENABLED, type FileSpeakerReview } from "@/lib/speaker-review";
import { cn } from "@/lib/utils";
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
  speakerDisplayLabel,
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
  type CorrectedRange,
  type CorrectionSet,
} from "@/lib/transcript-corrections";

export interface TranscriptPlayerHandle {
  /** Flyttar spelhuvudet; med `autoplay` startar även uppspelningen. */
  seekTo(fileIndex: number, time: number, autoplay?: boolean): void;
  /** Plays from `start` and stops at `end` (seconds in the part), as a sample. */
  playRange(fileIndex: number, start: number, end: number): void;
}

export type CorrectionsSaveState = "idle" | "saving" | "saved" | "error";

const RATES = [0.75, 1, 1.25, 1.5, 2];
const NO_SOURCES: readonly PlayerSource[] = [];
const EMPTY_SET: ReadonlySet<string> = new Set();
const NONE_LIT: ReadonlySet<number> = new Set();
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

function rateLabel(rate: number): string {
  return `${String(rate).replace(".", ",")}×`;
}

export function speakerColor(label: string | null): string {
  const index = label ? speakerColorIndex(label) : 0;
  return `hsl(var(--speaker-${index}))`;
}

/** A speaker's round mark: the initial on the speaker's colour, the same everywhere on the page. */
export function SpeakerMark({ label, name, className }: { label: string | null; name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-7 shrink-0 select-none place-items-center rounded-full text-[12px] font-semibold text-paper",
        !label && "bg-ink-mute",
        className,
      )}
      style={label ? { background: speakerColor(label) } : undefined}
    >
      {label ? speakerInitial(name) : "?"}
    </span>
  );
}

type Piece = {
  text: string;
  word: TranscriptWord | null;
  wordIndex: number;
  /** Ursprunglig text när biten är ett rättat spann. */
  correctedFrom: string | null;
  /** A search hit: "current" is the one the arrows are on. */
  hit: "match" | "current" | null;
};

type Hit = { start: number; end: number; current: boolean };

/**
 * Segmentets text uppdelad vid varje ord-, rättnings- och sökgräns, så att en
 * bit är antingen vanlig text, ett tidsatt ord eller ett rättat spann.
 */
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
  // En ren radering lämnar inget spann att peka på; visa en smal markör.
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

export const TranscriptPlayer = forwardRef<
  TranscriptPlayerHandle,
  {
    /** Råa segment; korrigeringar läggs på vid visning. */
    segments: readonly TranscriptSegment[];
    speakerReviews?: readonly FileSpeakerReview[];
    reviewEnabled?: boolean;
    correctionProblem?: string | null;
    /** Antal ljudfiler; 0 = inget ljud, bara läsbart transkript. */
    fileCount: number;
    audioSrcFor: (fileIndex: number) => string;
    /** Rå etikett → namn som granskaren valt, läggs ovanpå segmentens etiketter. */
    speakerNames: Readonly<Record<string, string>>;
    /** Visas när segment saknas helt. */
    textFallback: string;
    audioPending?: boolean;
    className?: string;
    /** Sparade/osparade korrigeringar som ska visas ovanpå råtexten. */
    corrections?: CorrectionSet;
    /** Tillåt rättning av repliker och talarbyte. Kräver `onCorrectionsChange`. */
    editable?: boolean;
    onCorrectionsChange?: (next: CorrectionSet) => void;
    /** Etiketter en replik kan tilldelas (SPEAKER_NN). */
    speakerOptions?: readonly string[];
    saveState?: CorrectionsSaveState;
    /** Osäkra ord som granskaren lyssnat på och bekräftat (se lib/confirmed-words). */
    confirmedWords?: ReadonlySet<string>;
    /** Gör det möjligt att bekräfta/ångra ett osäkert ord. */
    onToggleConfirmed?: (key: string) => void;
    /** Egen länk för att hämta det granskade transkriptet; av när sidan har egna åtgärder. */
    downloadable?: boolean;
    /**
     * The page's own playback of these parts, when the page shows it elsewhere too
     * (a pause control beside the document); otherwise the transcript owns one.
     */
    playback?: Playback;
  }
>(function TranscriptPlayer(
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
  },
  ref,
) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const programmaticScrollUntil = useRef(0);
  const searchId = useId();

  const [follow, setFollow] = useState(true);
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
      const name = speakerNames[label];
      return name && name.trim() ? name.trim() : speakerDisplayLabel(label);
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

  useImperativeHandle(
    ref,
    () => ({ seekTo, playRange: (fileIndex, start, end) => playback.playRange(fileIndex, start * 1_000, end * 1_000) }),
    [seekTo, playback],
  );

  function cycleRate() {
    playback.setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length]);
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

  // Följ uppspelningen: rulla den aktiva repliken till mitten.
  useEffect(() => {
    if (!follow || activeIndex < 0 || !listRef.current || editingIndex >= 0) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-segment-index="${activeIndex}"]`,
    );
    const block = el?.closest<HTMLElement>("[data-turn-index]") ?? el;
    if (!block) return;
    programmaticScrollUntil.current = Date.now() + 800;
    block.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }, [activeIndex, follow, editingIndex]);

  // The search's current hit is brought into view, and playback stops pulling the text away from it.
  useEffect(() => {
    if (currentHit < 0 || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>('[data-hit="current"]');
    if (!el) return;
    programmaticScrollUntil.current = Date.now() + 800;
    setFollow(false);
    el.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
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
    // Eneo refuses a set with more speaker edits than it holds; say so before sending.
    if (next.speaker_edits.length > MAX_SPEAKER_EDITS) {
      return `Det blir fler än ${MAX_SPEAKER_EDITS.toLocaleString("sv-SE")} talarändringar i transkriptet, mer än Eneo sparar. Ändra färre inlägg åt gången.`;
    }
    setEditError(null);
    onCorrectionsChange?.(next);
    return null;
  }

  if (!hasSegments && !(reviewEnabled && speakerReviews.length)) {
    return (
      <section className={cn("flex flex-col", className)} aria-label="Transkript">
        <p className="px-4 pt-4 text-[12px] text-ink-mute">
          Transkriptet saknar tidsmarkeringar och kan inte följas i ljudet.
        </p>
        <pre className="whitespace-pre-wrap px-4 py-4 text-[15px] leading-relaxed font-sans text-ink">
          {textFallback}
        </pre>
      </section>
    );
  }

  // Parts are read in order, each under its own heading when the recording has more than one.
  const parts: { fileIndex: number; turns: TranscriptTurn[] }[] = [];
  for (const turn of visibleTurns) {
    const last = parts[parts.length - 1];
    if (last && last.fileIndex === turn.fileIndex) last.turns.push(turn);
    else parts.push({ fileIndex: turn.fileIndex, turns: [turn] });
  }
  // Search works on any transcript; the speaker row only where the flow labelled speakers.
  const tools = !reviewEnabled && hasSegments;
  // No count until there is something to look for; then "1 av 3".
  const hitStatus = !query.trim() ? "" : hits.length === 0 ? "Inga träffar" : `${currentHit + 1} av ${hits.length}`;

  return (
    <section
      className={cn("transcript-player flex min-h-0 flex-col", className)}
      role="region"
      aria-label="Inspelning och transkript"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {tools && (
        <div className="flex flex-col gap-3 border-b border-rule-soft px-3 pb-3 pt-1">
          {labelled && (<>
          {/* The speaker filter, nothing else: chips that wrap from a laptop's width and scroll on a phone. */}
          <ToggleGroup
            type="single"
            variant="chip"
            size="sm"
            value={shownFilter}
            onValueChange={(value) => setFilter(value || "all")}
            aria-label="Visa talare"
            className={cn(
              "-mx-3 flex-nowrap justify-start overflow-x-auto px-3 py-1 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0",
              speakers.length > CHIP_LIMIT && "max-lg:hidden",
            )}
          >
            <ToggleGroupItem value="all" className="shrink-0 px-3">
              Alla
            </ToggleGroupItem>
            {speakers.map((speaker) => (
              <ToggleGroupItem key={speaker.label} value={speaker.label} className="shrink-0 gap-1.5 pl-1 pr-3">
                <SpeakerMark label={speaker.label} name={displayName(speaker.label)} className="size-6 text-[11px]" />
                {displayName(speaker.label)}
              </ToggleGroupItem>
            ))}
            {/* The passages to check are a to-do, set apart from the speakers, so they are counted. */}
            {toCheck > 0 && (
              <>
                <Separator orientation="vertical" className="mx-1 h-6 self-center" />
                <ToggleGroupItem value={TO_CHECK} className="shrink-0 gap-1.5 px-3">
                  <AlertTriangle aria-hidden className="text-ochre" />
                  Osäkra ({toCheck})
                </ToggleGroupItem>
              </>
            )}
          </ToggleGroup>
          {/* A large meeting on a narrow screen picks one speaker from a list instead of endless chips. */}
          {speakers.length > CHIP_LIMIT && (
            <div className="lg:hidden">
              <Select value={shownFilter} onValueChange={setFilter}>
                <SelectTrigger aria-label="Filtrera talare">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alla talare</SelectItem>
                  {speakers.map((speaker) => (
                    <SelectItem key={speaker.label} value={speaker.label}>
                      {displayName(speaker.label)}
                    </SelectItem>
                  ))}
                  {toCheck > 0 && <SelectItem value={TO_CHECK}>Osäkra ({toCheck})</SelectItem>}
                </SelectContent>
              </Select>
            </div>
          )}
          </>)}

          <div className="flex items-center gap-2">
            <InputGroup className="min-w-0 flex-1">
              <InputGroupAddon>
                <Search aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                id={searchId}
                type="search"
                value={query}
                placeholder="Sök i transkriptet"
                aria-label="Sök i transkriptet"
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHitIndex(0);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  stepHit(e.shiftKey ? -1 : 1);
                }}
              />
              {query.trim() && (
                <InputGroupAddon align="inline-end" className="cursor-default tabular-nums">
                  {hitStatus}
                </InputGroupAddon>
              )}
            </InputGroup>
            {query.trim() && (
              <>
                <Button type="button" variant="outline" size="icon" aria-label="Föregående träff" disabled={hits.length === 0} onClick={() => stepHit(-1)}>
                  <ChevronUp aria-hidden />
                </Button>
                <Button type="button" variant="outline" size="icon" aria-label="Nästa träff" disabled={hits.length === 0} onClick={() => stepHit(1)}>
                  <ChevronDown aria-hidden />
                </Button>
              </>
            )}
          </div>
          {/* The count is said once per change, not per keystroke's markup. */}
          <p role="status" className="sr-only">{hitStatus && hits.length > 0 ? `Träff ${hitStatus}` : hitStatus}</p>
        </div>
      )}

      {(audioPending ||
        audioUnavailable ||
        fileCount === 0 ||
        uncertainWords > 0 ||
        saveState !== "idle") && (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 pt-2 text-[12px] leading-relaxed">
          <div className="min-w-0">
            {audioPending && <p className="text-ink-mute">Hämtar ljud…</p>}
            {!audioPending && fileCount === 0 && (
              <p className="text-ink-mute">Ljudet är inte tillgängligt för den här körningen.</p>
            )}
            {audioUnavailable && (
              <p className="text-destructive">
                Ljudet kunde inte spelas.{" "}
                <button
                  type="button"
                  className="inline-flex min-h-6 items-center underline coarse:min-h-11"
                  onClick={() => playback.reload()}
                >
                  Försök igen
                </button>
              </p>
            )}
            {uncertainWords > 0 && (
              <p className="text-ink-mute">
                {uncertain.remaining > 0 ? (
                  <>
                    <span className="rounded-[3px] bg-ochre/25 px-1 text-ink">
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
                  <span className="text-ink-mute"> {uncertain.confirmed} bekräftade.</span>
                )}
              </p>
            )}
          </div>
          {saveState !== "idle" && (
            <p
              className={cn(
                "shrink-0 text-[12px]",
                saveState === "error" ? "text-destructive" : "text-ink-mute",
              )}
              aria-live="polite"
            >
              {saveState === "saving"
                ? "Sparar…"
                : saveState === "saved"
                  ? "Rättningar sparade"
                  : "Kunde inte spara"}
            </p>
          )}
        </div>
      )}

      {correctionProblem && <p role="alert" className="px-3 py-2 text-[12px] text-destructive">{correctionProblem}</p>}
      {editError && <p role="alert" className="px-3 pt-2 text-[13px] text-destructive">{editError}</p>}
      {downloadable && corrections && !correctionProblem && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mx-1 mt-1 shrink-0 self-start"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([renderReviewedTranscript(segments, corrections, speakerNames)], { type: "text/plain;charset=utf-8" }));
            const link = document.createElement("a"); link.href = url; link.download = "granskat-transkript.txt"; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          <Download data-icon="inline-start" aria-hidden />
          Hämta granskat transkript
        </Button>
      )}

      {/* The text and its player: the player's sticking stays within the text, never over the tools above. */}
      <div className="flex min-h-0 flex-1 flex-col">
      {/* Transkript: on a phone it is part of the page, from a laptop it scrolls inside its card. */}
      <div
        ref={listRef}
        onWheel={onUserScroll}
        onTouchMove={onUserScroll}
        className={cn("transcript-scrollport min-h-0 flex-1 lg:overflow-y-auto", !reviewEnabled && "px-1 py-2")}
      >
        {reviewEnabled ? <TranscriptEditor raw={segments} shown={shown} corrections={corrections} reviews={speakerReviews} labelled={labelled}
          editable={canReview} textEditable={canEdit} onChange={onCorrectionsChange} displayName={displayName} speakerOptions={labelOptions}
          audioAvailable={hasAudio && !audioUnavailable} currentFile={currentFile} currentTime={playhead} playing={!paused} onSeek={(fileIndex, time, autoplay, end) => {
            if (end === undefined) return seekTo(fileIndex, time, autoplay);
            // "Lyssna" on a passage plays it and stops at its end.
            if (hasAudio) setFollow(true);
            playback.playRange(fileIndex, time * 1_000, end * 1_000);
          }}
          confirmedWords={confirmedWords} onToggleConfirmed={onToggleConfirmed}
          onInteract={() => setFollow(false)} /> : parts.map((part) => (
          <div key={part.fileIndex} className="flex flex-col">
            {totalFiles > 1 && (
              <h3 className="px-2 pb-1 pt-3 text-[13px] font-medium text-ink-mute">Del {part.fileIndex + 1}</h3>
            )}
            <ol className="flex flex-col" aria-label={totalFiles > 1 ? `Del ${part.fileIndex + 1}` : "Transkriptet"}>
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
                    // A passage is lit only while it plays; a paused recording lights nothing.
                    activeIndices={paused ? NONE_LIT : activeIndices}
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
                    onSeekTurn={() => seekTo(turn.fileIndex, turn.start, !paused)}
                    onPartClick={onPartClick}
                  />
                );
              })}
            </ol>
          </div>
        ))}
        {!reviewEnabled && visibleTurns.length === 0 && (
          <p className="px-3 py-6 text-[14px] text-ink-mute">Inga repliker att visa.</p>
        )}
      </div>

      {hasAudio && (
        // Docked under the text: on a phone it stays in view while the transcript is on screen.
        <div data-docked-player className="sticky bottom-0 z-10 rounded-b-xl border-t border-rule-soft bg-card px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] lg:static lg:pb-2">
          <AudioPlayer playback={playback} label="Inspelningen">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="hidden shrink-0 rounded-full sm:inline-flex"
              disabled={audioUnavailable}
              aria-label={`Bakåt ${SKIP_SECONDS} sekunder`}
              onClick={() => playback.skip(-SKIP_SECONDS * 1_000)}
            >
              <RotateCcw aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="hidden shrink-0 rounded-full sm:inline-flex"
              disabled={audioUnavailable}
              aria-label={`Framåt ${SKIP_SECONDS} sekunder`}
              onClick={() => playback.skip(SKIP_SECONDS * 1_000)}
            >
              <RotateCw aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0 px-2 tabular-nums coarse:min-w-11"
              aria-label={`Hastighet ${rateLabel(rate)}`}
              onClick={cycleRate}
            >
              {rateLabel(rate)}
            </Button>
            {!follow && (
              <Button type="button" variant="ghost" size="sm" className="shrink-0 text-primary" onClick={() => setFollow(true)}>
                Följ
              </Button>
            )}
          </AudioPlayer>
        </div>
      )}
      </div>
    </section>
  );
});

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

  const picker = (trigger: React.ReactNode) => (
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
      className={cn(
        "group/turn flex gap-3 rounded-lg px-2 py-2.5 transition-colors",
        isActive && "bg-primary-soft/60",
      )}
    >
      {labelled && <SpeakerMark label={markLabel} name={displayName(turn.speaker)} className="mt-px" />}
      <div className="min-w-0 flex-1">
        {/* On a touch screen the head's controls are 44 px targets; negative margins keep the row compact. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {labelled && toCheck && <span className="text-[15px] font-semibold leading-tight text-ink-soft">{name}</span>}
          {labelled && !toCheck &&
            (canPickSpeaker ? (
              picker(
                <button
                  type="button"
                  // The name starts with the words on the button (WCAG 2.5.3) and says what it does.
                  aria-label={`${name}, ändra talare`}
                  className="inline-flex min-h-6 items-center gap-1 rounded text-left text-[15px] font-semibold leading-tight text-ink decoration-dotted underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring coarse:-my-2.5 coarse:min-h-11 coarse:min-w-11"
                >
                  {name}
                  <ChevronDown aria-hidden className="size-3.5 text-ink-mute" />
                </button>,
              )
            ) : (
              <span className="text-[15px] font-semibold leading-tight text-ink">{name}</span>
            ))}
          <button
            type="button"
            onClick={onSeekTurn}
            aria-label={`Spela från ${clock}${partLabel}`}
            className={cn(
              "-mx-1 inline-flex min-h-6 min-w-6 items-center rounded px-1 text-[13px] tabular-nums hover:text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring coarse:-my-2.5 coarse:min-h-11 coarse:min-w-11",
              isActive ? "text-ink" : "text-ink-mute",
            )}
          >
            {clock}
          </button>
          {labelled && toCheck && canPickSpeaker &&
            picker(
              <Button type="button" variant="link" size="sm" className="-my-1 px-1 coarse:-my-2.5">
                Ändra talare
              </Button>,
            )}
        </div>
        {choosable && <p className="mt-1 text-[13px] text-ink-mute">Välj meningen du vill rätta.</p>}
        <div className="mt-0.5 text-[15px] leading-[1.65] text-ink">
          {turn.parts.map((part) => {
            const partActive = activeIndices.has(part.segmentIndex);
            const corrected = correctedIndices.has(part.segmentIndex);
            const ranges = correctedRanges.get(part.segmentIndex) ?? [];
            const partClock = formatClock(part.segment.start * 1_000);
            if (editingIndex === part.segmentIndex) {
              return (
                <LineEditor
                  key={part.segmentIndex}
                  initial={textForEdit(part.segmentIndex)}
                  corrected={corrected}
                  label={`Rätta repliken från ${partClock}`}
                  onCommit={(text) => onCommitLine(part.segmentIndex, text)}
                  onCancel={onCancelEdit}
                  onRevert={() => onRevertLine(part.segmentIndex)}
                />
              );
            }
            const shown = pieces(part.segment, ranges, hitsBySegment.get(part.segmentIndex));
            return (
              <span key={part.segmentIndex} className="group/part">
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
                    "aria-label": `${shown.map((piece) => piece.text).join("").replace(/\s+/g, " ").trim()} Rätta meningen från ${partClock}.`,
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      onStartEdit(part.segmentIndex);
                    },
                  })}
                  className={cn(
                    "cursor-pointer rounded-sm box-decoration-clone transition-colors",
                    partActive && "bg-primary/10",
                    // A tint on every sentence, stronger where pointed at or focused (a dotted line in forced colours,
                    // which drop tints); the padding grows the target to 24 px without moving the lines, and on a
                    // touch screen each sentence is a 44 px row.
                    choosable &&
                      "bg-primary-soft/50 bg-clip-content py-1 hover:bg-primary/20 focus-visible:bg-primary/20 coarse:my-1 coarse:block coarse:min-h-11 coarse:bg-clip-border coarse:px-2 coarse:py-2.5 forced-colors:underline forced-colors:decoration-dotted",
                  )}
                >
                  {shown.map((piece, k, all) => {
                    const key = piece.word ? wordKey(part.segment.sourceSegmentIndex ?? part.segmentIndex, piece.word) : null;
                    const confirmed = key !== null && confirmedWords.has(key);
                    const flagged = Boolean(piece.word?.uncertain) && !confirmed;
                    const isWordActive =
                      Boolean(piece.word) && partActive && piece.wordIndex === findActiveWordIndex(part.segment.words ?? [], currentTime);
                    // Bekräftelseknappen sitter efter ordets sista bit.
                    const lastOfWord =
                      Boolean(piece.word?.uncertain) &&
                      all[k + 1]?.wordIndex !== piece.wordIndex;
                    const Text = piece.hit ? "mark" : "span";
                    return (
                      <span key={k}>
                        <Text
                          data-word-start={piece.word ? piece.word.start : undefined}
                          data-hit={piece.hit ?? undefined}
                          className={cn(
                            "rounded-[3px] box-decoration-clone",
                            flagged &&
                              "bg-ochre/25 px-[2px] -mx-[2px] underline decoration-wavy decoration-ochre underline-offset-[3px]",
                            confirmed &&
                              "bg-ok/15 px-[2px] -mx-[2px] text-ok underline decoration-dotted decoration-ok/70 underline-offset-[3px]",
                            piece.hit === "match" && "bg-primary-soft text-ink",
                            piece.hit === "current" && "bg-primary text-primary-foreground",
                            isWordActive && "bg-primary text-primary-foreground",
                            piece.correctedFrom !== null &&
                              "underline decoration-dotted decoration-primary underline-offset-[3px]",
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
                          {piece.correctedFrom !== null && <span className="sr-only"> (rättad från {piece.correctedFrom})</span>}
                        </Text>
                        {lastOfWord && onToggleConfirmed && key !== null && !choosable && (
                          <button
                            type="button"
                            className="group/confirm -my-1 -ml-[1.5px] -mr-[4.5px] inline-grid size-6 translate-y-[-1px] place-items-center rounded-full align-middle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring coarse:-my-[14.5px] coarse:-ml-[11.5px] coarse:-mr-[14.5px] coarse:size-11"
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
                            <span
                              aria-hidden
                              className={cn(
                                "grid size-[15px] place-items-center rounded-full border transition-colors",
                                confirmed
                                  ? "border-transparent bg-ok text-paper group-hover/confirm:bg-ok/80"
                                  : "border-ochre text-ochre group-hover/confirm:bg-ochre group-hover/confirm:text-ink",
                              )}
                            >
                              <Check className="h-[9px] w-[9px]" strokeWidth={3} />
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
            // After the passage, never mid-sentence: a mouse sees it on the passage it points at or has in
            // focus, a touch screen on every passage.
            <button
              type="button"
              aria-label={several ? (choosing ? `Klar med repliken från ${clock}` : `Rätta repliken från ${clock}: välj mening`) : `Rätta repliken från ${clock}`}
              aria-expanded={several ? choosing : undefined}
              onClick={() => (several ? setChoosing(!choosing) : onStartEdit(turn.parts[0].segmentIndex))}
              // At rest with a mouse it takes no room, so a passage never gains an empty line.
              className={cn(
                "-my-1 inline-flex min-h-6 items-center gap-1 overflow-hidden rounded align-baseline text-[13px] text-ink-mute hover:bg-accent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring coarse:-my-2.5 coarse:ml-0.5 coarse:min-h-11 coarse:w-auto coarse:px-1.5 coarse:text-ink-soft coarse:opacity-100",
                choosing
                  ? "ml-0.5 w-auto px-1.5 opacity-100"
                  : "w-0 px-0 opacity-0 focus-visible:ml-0.5 focus-visible:w-auto focus-visible:px-1.5 focus-visible:opacity-100 group-hover/turn:ml-0.5 group-hover/turn:w-auto group-hover/turn:px-1.5 group-hover/turn:opacity-100",
              )}
            >
              {choosing ? <Check aria-hidden className="size-3.5" strokeWidth={2} /> : <Pencil aria-hidden className="size-3.5" strokeWidth={2} />}
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
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<string>(current ?? "");
  const [scope, setScope] = useState<"one" | "all">("one");
  const [problem, setProblem] = useState<string | null>(null);
  const titleId = useId();
  const others = suggested ? options.filter((label) => label !== suggested) : options;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          // Every opening starts from this passage alone; all of a speaker's passages is a deliberate choice.
          setChoice(current ?? "");
          setScope("one");
          setProblem(null);
        }
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-[22rem] max-w-[calc(100vw-2rem)] p-0" aria-labelledby={titleId}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!choice) return;
            const refused = onPick(choice, choice !== UNRESOLVED && scope === "all" && passages > 1);
            setProblem(refused);
            if (!refused) setOpen(false);
          }}
        >
          <div className="border-b border-border px-4 py-3">
            <p id={titleId} className="text-[14px] font-semibold text-ink">Ändra talare</p>
            <p className="mt-0.5 line-clamp-2 text-[13px] text-ink-mute">{quote}</p>
          </div>
          <RadioGroup value={choice} onValueChange={setChoice} aria-labelledby={titleId} className="max-h-64 gap-0 overflow-y-auto p-1.5">
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
          </RadioGroup>
          {passages > 1 && choice !== UNRESOLVED && (
            <div className="border-t border-border px-4 py-3">
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={scope}
                onValueChange={(value) => value && setScope(value as "one" | "all")}
                aria-label="Gäller"
                className="grid grid-cols-2 gap-1"
              >
                <ToggleGroupItem value="one" className="h-auto min-h-8 whitespace-normal py-1.5 text-[13px] leading-snug data-[state=on]:border-primary data-[state=on]:bg-primary-soft">
                  Bara det här inlägget
                </ToggleGroupItem>
                <ToggleGroupItem value="all" className="h-auto min-h-8 whitespace-normal py-1.5 text-[13px] leading-snug data-[state=on]:border-primary data-[state=on]:bg-primary-soft">
                  Alla {passages} inlägg från {fromName}
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          )}
          {problem && (
            <p role="alert" className="border-t border-border px-4 py-3 text-[13px] text-destructive">
              {problem}
            </p>
          )}
          <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Avbryt
            </Button>
            <Button type="submit" size="sm" disabled={!choice || choice === current}>
              Spara
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function PickerOption({ value, label, name, markName = name, note }: { value: string; label: string | null; name: string; markName?: string; note?: string }) {
  return (
    <label className="flex min-h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-[14px] text-ink hover:bg-accent coarse:min-h-11">
      <RadioGroupItem value={value} />
      <SpeakerMark label={label} name={markName} className="size-6 text-[11px]" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {note && <span className="shrink-0 text-[12px] text-ink-mute">{note}</span>}
    </label>
  );
}

function LineEditor({
  initial,
  corrected,
  label,
  onCommit,
  onCancel,
  onRevert,
}: {
  initial: string;
  corrected: boolean;
  label: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
  onRevert: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  return (
    <div
      className="my-1"
      // Focus moving between the text and its buttons stays in the editor; leaving it all saves or closes.
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        if (value !== initial) onCommit(value);
        else onCancel();
      }}
    >
      <textarea
        ref={ref}
        value={value}
        rows={1}
        aria-label={label}
        onChange={(e) => {
          setValue(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = `${e.target.scrollHeight}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onCommit(value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        className="w-full resize-none rounded-md border border-rule bg-paper px-2 py-1 text-[15px] leading-[1.65] text-ink focus:outline-none focus:ring-2 focus:ring-primary coarse:text-base"
      />
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-mute">
        {/* Pressed without taking the focus, so leaving the field does not save first. */}
        <Button type="button" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={() => onCommit(value)}>
          Spara
        </Button>
        <Button type="button" size="sm" variant="ghost" onMouseDown={(e) => e.preventDefault()} onClick={onCancel}>
          Avbryt
        </Button>
        <span className="coarse:hidden">Enter sparar · Esc avbryter</span>
        {corrected && (
          <Button type="button" size="sm" variant="link" className="px-0" onMouseDown={(e) => e.preventDefault()} onClick={onRevert}>
            Återställ originalet
          </Button>
        )}
      </div>
    </div>
  );
}
