"use client";

import { Check, ChevronDown, Pencil, RotateCcw, RotateCw } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { TranscriptEditor } from "@/components/TranscriptEditor";
import { AudioPlayer, usePlayback, usePlaybackState } from "@/components/flow/AudioPlayer";
import { Button } from "@/components/ui/button";
import type { PlayerSource } from "@/lib/playback";
import { SPEAKER_REVIEW_ENABLED, type FileSpeakerReview } from "@/lib/speaker-review";
import { cn } from "@/lib/utils";
import { countUncertain, wordKey } from "@/lib/confirmed-words";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  computeTurns,
  countFiles,
  findActiveSegmentIndex,
  findActiveSegmentIndices,
  effectiveSpeakerLabel,
  needsSpeakerReview,
  findActiveWordIndex,
  formatClock,
  speakerColorIndex,
  speakerDisplayLabel,
  type TranscriptSegment,
  type TranscriptTurn,
  type TranscriptTurnPart,
  type TranscriptWord,
} from "@/lib/transcript";
import {
  applyCorrections,
  occurrencesForLine,
  withLineCorrection,
  withSpeakerEdit,
  correctedSegmentText,
  correctionWriteProblem,
  renderReviewedTranscript,
  type CorrectedRange,
  type CorrectionSet,
} from "@/lib/transcript-corrections";

export interface TranscriptPlayerHandle {
  /** Flyttar spelhuvudet; med `autoplay` startar även uppspelningen. */
  seekTo(fileIndex: number, time: number, autoplay?: boolean): void;
}

export type CorrectionsSaveState = "idle" | "saving" | "saved" | "error";

const RATES = [0.75, 1, 1.25, 1.5, 2];
const NO_SOURCES: readonly PlayerSource[] = [];
const EMPTY_SET: ReadonlySet<string> = new Set();
const SKIP_SECONDS = 10;

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

type Piece = {
  text: string;
  word: TranscriptWord | null;
  wordIndex: number;
  /** Ursprunglig text när biten är ett rättat spann. */
  correctedFrom: string | null;
};

/**
 * Segmentets text uppdelad vid varje ord- och rättningsgräns, så att en bit
 * är antingen vanlig text, ett tidsatt ord eller ett rättat spann.
 */
function pieces(segment: TranscriptSegment, ranges: readonly CorrectedRange[]): Piece[] {
  const text = segment.text;
  const words = (segment.words ?? [])
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => w.charStart >= 0);
  const cuts = new Set<number>([0, text.length]);
  for (const { w } of words) {
    cuts.add(w.charStart);
    cuts.add(w.charEnd);
  }
  for (const r of ranges) {
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
    out.push({
      text: text.slice(start, end),
      word: word?.w ?? null,
      wordIndex: word?.i ?? -1,
      correctedFrom: range ? range.original : null,
    });
  }
  // En ren radering lämnar inget spann att peka på; visa en smal markör.
  for (const r of ranges) {
    if (r.end === r.start) {
      const at = out.findIndex((_, idx) => bounds[idx] >= r.start);
      const marker: Piece = { text: "\u202f", word: null, wordIndex: -1, correctedFrom: r.original };
      if (at < 0) out.push(marker);
      else out.splice(at, 0, marker);
    }
  }
  return out;
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
  },
  ref,
) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const programmaticScrollUntil = useRef(0);

  const [follow, setFollow] = useState(true);
  const [editingIndex, setEditingIndex] = useState(-1);
  const [editError, setEditError] = useState<string | null>(null);

  const hasAudio = fileCount > 0 && !audioPending;
  // The app's one set of playback controls; the transcript follows its position and seeks through it.
  const playback = usePlayback(
    hasAudio ? Array.from({ length: fileCount }, (_, i) => ({ url: audioSrcFor(i), durationMs: null })) : NO_SOURCES,
  );
  const position = usePlaybackState(playback);
  const currentFile = position.part;
  const currentTime = position.withinMs / 1_000;
  const paused = !position.playing;
  const audioUnavailable = position.unavailable;
  const rate = position.rate;

  const applied = useMemo(() => applyCorrections(segments, corrections), [segments, corrections]);
  const shown = applied.segments;
  const activeIndices = new Set(findActiveSegmentIndices(shown, currentFile, currentTime));
  // Scrolling follows only once playback has started or been moved.
  const activeIndex = position.started ? findActiveSegmentIndex(shown, currentFile, currentTime) : -1;
  const correctedIndices = applied.corrected;
  const correctedRanges = applied.ranges;
  const turns = useMemo(() => computeTurns(shown), [shown]);
  const totalFiles = Math.max(fileCount, countFiles(shown), ...speakerReviews.map((r) => r.fileIndex + 1));
  const partLengthMs = position.lengthsMs[currentFile] ?? 0;
  const withHours = useMemo(
    () => partLengthMs >= 3_600_000 || shown.some((s) => s.end >= 3600),
    [partLengthMs, shown],
  );
  const uncertain = useMemo(() => countUncertain(shown, confirmedWords), [shown, confirmedWords]);
  const uncertainWords = uncertain.remaining + uncertain.confirmed;
  const hasSegments = shown.length > 0;
  const canEdit = editable && !correctionProblem && typeof onCorrectionsChange === "function";
  const canReview = canEdit && reviewEnabled && corrections?.schemaVersion === 3 && !correctionWriteProblem(corrections);
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

  const seekTo = useCallback(
    (fileIndex: number, time: number, autoplay = false) => {
      if (hasAudio) setFollow(true);
      playback.seek(fileIndex, time * 1_000, autoplay);
    },
    [hasAudio, playback],
  );

  useImperativeHandle(ref, () => ({ seekTo }), [seekTo]);

  function cycleRate() {
    playback.setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length]);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const action = shortcut(e.key);
    if (!action) return;
    const target = e.target as HTMLElement;
    // The position slider moves by its own keys; controls and text fields keep theirs.
    if (target.closest("button, a, input, select, textarea, [role=slider], [role=menuitemradio], [contenteditable]")) return;
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

  function onUserScroll() {
    if (Date.now() < programmaticScrollUntil.current) return;
    if (follow) setFollow(false);
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

  function reassignTurn(turn: TranscriptTurn, speaker: string) {
    if (!canEdit || !corrections) return;
    let next = corrections;
    for (const part of turn.parts) {
      const sourceIndex = part.segment.sourceSegmentIndex ?? part.segmentIndex;
      const stored = segments[sourceIndex]?.speaker;
      if (!stored) continue;
      next = withSpeakerEdit(next, sourceIndex, stored, speaker);
    }
    onCorrectionsChange?.(next);
  }

  if (!hasSegments && !(reviewEnabled && speakerReviews.length)) {
    return (
      <section className={cn("flex flex-col", className)} aria-label="Transkript">
        <p className="px-4 pt-4 text-[12px] text-ink-mute">
          Transkriptet saknar tidsmarkeringar och kan inte följas i ljudet.
        </p>
        <pre className="whitespace-pre-wrap px-4 py-4 text-[13px] leading-relaxed font-sans text-ink">
          {textFallback}
        </pre>
      </section>
    );
  }

  return (
    <section
      className={cn("transcript-player flex min-h-0 flex-col", className)}
      role="region"
      aria-label="Inspelning och transkript"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {hasAudio && (
        <div className="border-b border-rule-soft px-3 py-2">
          <AudioPlayer playback={playback} label="Inspelningen">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="hidden size-11 shrink-0 rounded-full sm:inline-flex"
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
              className="hidden size-11 shrink-0 rounded-full sm:inline-flex"
              disabled={audioUnavailable}
              aria-label={`Framåt ${SKIP_SECONDS} sekunder`}
              onClick={() => playback.skip(SKIP_SECONDS * 1_000)}
            >
              <RotateCw aria-hidden />
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-11 shrink-0 rounded-full px-3 tabular-nums"
              aria-label={`Hastighet ${rateLabel(rate)}`}
              onClick={cycleRate}
            >
              {rateLabel(rate)}
            </Button>
            {!follow && (
              <Button type="button" variant="ghost" className="h-11 shrink-0 px-3 text-primary" onClick={() => setFollow(true)}>
                Följ
              </Button>
            )}
          </AudioPlayer>
        </div>
      )}

      {totalFiles > 1 && hasAudio && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-rule-soft px-3 py-1.5">
          {Array.from({ length: totalFiles }, (_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => seekTo(i, 0, false)}
              aria-pressed={i === currentFile}
              className={cn(
                "min-h-8 min-w-8 rounded-full px-2.5 py-0.5 text-[12px]",
                i === currentFile
                  ? "bg-primary text-primary-foreground"
                  : "text-ink-soft hover:text-ink border border-rule-soft",
              )}
            >
              Del {i + 1}
            </button>
          ))}
        </div>
      )}

      {(audioPending ||
        audioUnavailable ||
        fileCount === 0 ||
        uncertainWords > 0 ||
        canEdit ||
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
                  className="underline"
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
            {canEdit && !audioPending && (
              <p className="text-ink-mute">
                {reviewEnabled ? (
                  "Markera orden du vill granska direkt i transkriptet."
                ) : (
                  <>
                    {/* A mouse finds the pencil by pointing at a line; a touch screen shows it on every line. */}
                    <span className="[@media(pointer:coarse)]:hidden">
                      Peka på en replik och välj pennan för att rätta texten. Välj talarens namn för att byta talare.
                    </span>
                    <span className="hidden [@media(pointer:coarse)]:inline">
                      Tryck på pennan vid en replik för att rätta texten, eller på talarens namn för att byta talare.
                    </span>
                  </>
                )}
              </p>
            )}
          </div>
          {saveState !== "idle" && (
            <p
              className={cn(
                "shrink-0 text-[11px]",
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
      {editError && <p role="alert" className="px-3 text-destructive">{editError}</p>}
      {downloadable && corrections && !correctionProblem && <button type="button" className="self-start px-3 py-2 text-[12px] underline" onClick={() => {
        const url = URL.createObjectURL(new Blob([renderReviewedTranscript(segments, corrections, speakerNames)], { type: "text/plain;charset=utf-8" }));
        const link = document.createElement("a"); link.href = url; link.download = "granskat-transkript.txt"; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}>Hämta granskat transkript</button>}
      {/* Transkript */}
      <div
        ref={listRef}
        onWheel={onUserScroll}
        onTouchMove={onUserScroll}
        className={cn("transcript-scrollport min-h-0 flex-1 overflow-y-auto max-h-[60vh] lg:max-h-none", !reviewEnabled && "p-2")}
      >
        {reviewEnabled ? <TranscriptEditor raw={segments} shown={shown} corrections={corrections} reviews={speakerReviews}
          editable={canReview} textEditable={canEdit} onChange={onCorrectionsChange} displayName={displayName} speakerOptions={labelOptions}
          audioAvailable={hasAudio && !audioUnavailable} currentFile={currentFile} currentTime={currentTime} playing={!paused} onSeek={(fileIndex, time, autoplay, end) => {
            if (end === undefined) return seekTo(fileIndex, time, autoplay);
            // "Lyssna" on a passage plays it and stops at its end.
            if (hasAudio) setFollow(true);
            playback.playRange(fileIndex, time * 1_000, end * 1_000);
          }}
          confirmedWords={confirmedWords} onToggleConfirmed={onToggleConfirmed}
          onInteract={() => setFollow(false)} /> : turns.map((turn, i) => (
          <TurnBlock
            key={turn.index}
            turn={turn}
            rawSegments={segments}
            correctedIndices={correctedIndices}
            correctedRanges={correctedRanges}
            showFileHeading={totalFiles > 1 && (i === 0 || turns[i - 1].fileIndex !== turn.fileIndex)}
            activeIndices={activeIndices}
            currentTime={currentTime}
            withHours={withHours}
            name={effectiveSpeakerLabel(turn.parts[0].segment, displayName)}
            displayName={displayName}
            labelOptions={labelOptions}
            canEdit={canEdit && (canReview || turn.parts.every((p) => !needsSpeakerReview(p.segment) &&
              !corrections?.speaker_edits.some((e) => e.segment_index === (p.segment.sourceSegmentIndex ?? p.segmentIndex) && e.char_start !== null)))}
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
            onReassign={(speaker) => reassignTurn(turn, speaker)}
            onSeekTurn={() => seekTo(turn.fileIndex, turn.start, !paused)}
            onPartClick={onPartClick}
          />
        ))}
      </div>
    </section>
  );
});

function TurnBlock({
  turn,
  rawSegments,
  correctedIndices,
  correctedRanges,
  showFileHeading,
  activeIndices,
  currentTime,
  withHours,
  name,
  displayName,
  labelOptions,
  canEdit,
  confirmedWords,
  onToggleConfirmed,
  editingIndex,
  onStartEdit,
  onCancelEdit,
  onCommitLine,
  onRevertLine,
  onReassign,
  onReview,
  textForEdit,
  onSeekTurn,
  onPartClick,
}: {
  turn: TranscriptTurn;
  rawSegments: readonly TranscriptSegment[];
  correctedIndices: ReadonlySet<number>;
  correctedRanges: ReadonlyMap<number, CorrectedRange[]>;
  showFileHeading: boolean;
  activeIndices: ReadonlySet<number>;
  currentTime: number;
  withHours: boolean;
  name: string;
  displayName: (label: string | null) => string;
  labelOptions: readonly string[];
  canEdit: boolean;
  confirmedWords: ReadonlySet<string>;
  onToggleConfirmed?: (key: string) => void;
  editingIndex: number;
  onStartEdit: (segmentIndex: number) => void;
  onCancelEdit: () => void;
  onCommitLine: (segmentIndex: number, text: string) => void;
  onRevertLine: (segmentIndex: number) => void;
  onReassign: (speaker: string) => void;
  onReview?: () => void;
  textForEdit: (index: number) => string;
  onSeekTurn: () => void;
  onPartClick: (part: TranscriptTurnPart, e: React.MouseEvent) => void;
}) {
  const review = needsSpeakerReview(turn.parts[0].segment);
  const decision = turn.parts[0].segment.decision;
  const color = speakerColor(review && !decision ? null : turn.speaker);
  const isActive = turn.parts.some((p) => activeIndices.has(p.segmentIndex));
  const storedSpeaker = rawSegments[turn.parts[0]?.segment.sourceSegmentIndex ?? turn.parts[0]?.segmentIndex ?? -1]?.speaker ?? null;
  const reassigned = storedSpeaker !== null && storedSpeaker !== turn.speaker;

  return (
    <>
      {showFileHeading && (
        <div className="px-2 pt-3 pb-1 text-[11px] text-ink-mute">Del {turn.fileIndex + 1}</div>
      )}
      <div
        data-turn-index={turn.index}
        data-active={isActive}
        className={cn(
          "group grid grid-cols-[4.25rem_minmax(0,1fr)] gap-x-3 rounded-lg px-2 py-2 sm:grid-cols-[5.5rem_minmax(0,1fr)]",
          isActive && "bg-bg-2/60",
        )}
      >
        <div className="min-w-0 pt-[2px]">
          <button
            type="button"
            onClick={onSeekTurn}
            aria-label={`Spela från ${formatClock(turn.start, withHours)}`}
            className={cn(
              "font-mono text-[11px] tabular-nums hover:underline",
              isActive ? "text-ink" : "text-ink-mute",
            )}
          >
            {formatClock(turn.start, withHours)}
          </button>
          {(() => {
            const nameButton = (
              <button
                type="button"
                disabled={!canEdit || (!turn.speaker && !onReview)}
                onClick={onReview}
                aria-label={name}
                title={
                  reassigned
                    ? `Bytt från ${displayName(storedSpeaker)}`
                    : canEdit
                      ? "Byt talare"
                      : undefined
                }
                className={cn(
                  "mt-0.5 flex max-w-full items-center gap-1.5 rounded text-left text-[12px] font-semibold leading-tight",
                  canEdit &&
                    "hover:underline decoration-dotted underline-offset-2 data-[state=open]:underline",
                  "disabled:cursor-default disabled:no-underline",
                )}
                style={{ color }}
              >
                <span
                  aria-hidden
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    reassigned && "ring-2 ring-offset-1 ring-offset-paper",
                  )}
                  style={{ background: color, ["--tw-ring-color" as string]: color }}
                />
                <span>{review && !decision ? "Osäker talare" : decision === "unresolved" ? "Oavgjord" : name}</span>
                {canEdit && (
                  <ChevronDown className="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-70 data-[state=open]:opacity-70 [@media(pointer:coarse)]:opacity-70" />
                )}
              </button>
            );
            if (!canEdit || !turn.speaker || onReview) return nameButton;
            return (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>{nameButton}</DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[12rem]">
                  <DropdownMenuLabel className="text-[11px] font-normal text-ink-mute">
                    Vem säger det här?
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuRadioGroup value={turn.speaker ?? ""} onValueChange={onReassign}>
                    {labelOptions.map((label) => (
                      <DropdownMenuRadioItem key={label} value={label} className="gap-2 text-[13px]">
                        <span
                          aria-hidden
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ background: speakerColor(label) }}
                        />
                        <span className="truncate">{displayName(label)}</span>
                        {label === storedSpeaker && (
                          <span className="ml-auto pl-3 text-[11px] text-ink-mute">ursprunglig</span>
                        )}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            );
          })()}
        </div>
        <div className="text-[14px] leading-[1.65] text-ink">
          {review && <p className="text-[11px] text-ink-mute">{decision === "unresolved" ? "Överlappande tal · Talare går inte att avgöra · Granskad" : decision === "confirmed" ? "Överlappande tal · Talare bekräftad" : "Överlappande tal – osäker talare · Inte granskat"}</p>}
          {turn.parts.map((part) => {
            const partActive = activeIndices.has(part.segmentIndex);
            const corrected = correctedIndices.has(part.segmentIndex);
            const ranges = correctedRanges.get(part.segmentIndex) ?? [];
            if (editingIndex === part.segmentIndex) {
              return (
                <LineEditor
                  key={part.segmentIndex}
                  initial={textForEdit(part.segmentIndex)}
                  corrected={corrected}
                  onCommit={(text) => onCommitLine(part.segmentIndex, text)}
                  onCancel={onCancelEdit}
                  onRevert={() => onRevertLine(part.segmentIndex)}
                />
              );
            }
            return (
              <span key={part.segmentIndex} className="group/part">
                <span
                  data-segment-index={part.segmentIndex}
                  onClick={(e) => onPartClick(part, e)}
                  className={cn(
                    "cursor-pointer rounded-sm box-decoration-clone transition-colors",
                    partActive && "bg-primary/10",
                  )}
                >
                  {pieces(part.segment, ranges).map((piece, k, all) => {
                    const key = piece.word ? wordKey(part.segment.sourceSegmentIndex ?? part.segmentIndex, piece.word) : null;
                    const confirmed = key !== null && confirmedWords.has(key);
                    const flagged = Boolean(piece.word?.uncertain) && !confirmed;
                    const isWordActive =
                      Boolean(piece.word) && partActive && piece.wordIndex === findActiveWordIndex(part.segment.words ?? [], currentTime);
                    // Bekräftelseknappen sitter efter ordets sista bit.
                    const lastOfWord =
                      Boolean(piece.word?.uncertain) &&
                      all[k + 1]?.wordIndex !== piece.wordIndex;
                    return (
                      <span key={k}>
                        <span
                          data-word-start={piece.word ? piece.word.start : undefined}
                          className={cn(
                            "rounded-[3px] box-decoration-clone",
                            flagged &&
                              "bg-ochre/25 px-[2px] -mx-[2px] underline decoration-wavy decoration-ochre underline-offset-[3px]",
                            confirmed &&
                              "bg-ok/15 px-[2px] -mx-[2px] text-ok underline decoration-dotted decoration-ok/70 underline-offset-[3px]",
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
                        </span>
                        {lastOfWord && onToggleConfirmed && key !== null && (
                          <button
                            type="button"
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
                            className={cn(
                              "ml-[3px] inline-grid h-[15px] w-[15px] translate-y-[-1px] place-items-center rounded-full border align-middle transition-colors",
                              confirmed
                                ? "border-transparent bg-ok text-paper hover:bg-ok/80"
                                : "border-ochre text-ochre hover:bg-ochre hover:text-ink",
                            )}
                          >
                            <Check className="h-[9px] w-[9px]" strokeWidth={3} />
                          </button>
                        )}
                      </span>
                    );
                  })}
                </span>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => onStartEdit(part.segmentIndex)}
                    aria-label="Rätta repliken"
                    className="relative inline-grid h-5 w-0 translate-y-[3px] place-items-center overflow-hidden rounded text-ink-mute opacity-0 hover:text-ink focus-visible:mx-1 focus-visible:w-5 focus-visible:opacity-100 group-hover/part:mx-1 group-hover/part:w-5 group-hover/part:opacity-100 [@media(pointer:coarse)]:mx-1 [@media(pointer:coarse)]:w-5 [@media(pointer:coarse)]:overflow-visible [@media(pointer:coarse)]:text-ink-soft [@media(pointer:coarse)]:opacity-100 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-3"
                  >
                    <Pencil className="h-3 w-3" strokeWidth={2} />
                  </button>
                )}
                {" "}
              </span>
            );
          })}
        </div>
      </div>
    </>
  );
}

function LineEditor({
  initial,
  corrected,
  onCommit,
  onCancel,
  onRevert,
}: {
  initial: string;
  corrected: boolean;
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
    <div className="my-1">
      <textarea
        ref={ref}
        value={value}
        rows={1}
        aria-label="Rätta repliken"
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
        onBlur={() => (value !== initial ? onCommit(value) : onCancel())}
        className="w-full resize-none rounded-md border border-rule bg-paper px-2 py-1 text-[14px] leading-[1.65] text-ink focus:outline-none focus:ring-2 focus:ring-primary"
      />
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-mute">
        {/* Pressed without taking the focus, so leaving the field does not save first. */}
        <Button type="button" size="sm" className="h-9 px-3 text-[13px] [@media(pointer:coarse)]:h-11" onMouseDown={(e) => e.preventDefault()} onClick={() => onCommit(value)}>
          Spara
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-9 px-3 text-[13px] [@media(pointer:coarse)]:h-11"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCancel}
        >
          Avbryt
        </Button>
        <span className="[@media(pointer:coarse)]:hidden">Enter sparar · Esc avbryter</span>
        {corrected && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onRevert}
            className="inline-flex min-h-9 items-center text-primary hover:underline [@media(pointer:coarse)]:min-h-11"
          >
            Återställ originalet
          </button>
        )}
      </div>
    </div>
  );
}
