"use client";

import { ChevronDown, Pause, Pencil, Play, RotateCcw, RotateCw } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import {
  computeTurns,
  countFiles,
  countUncertainWords,
  findActiveSegmentIndex,
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
  type CorrectedRange,
  type CorrectionSet,
} from "@/lib/transcript-corrections";

export interface TranscriptPlayerHandle {
  /** Flyttar spelhuvudet; med `autoplay` startar även uppspelningen. */
  seekTo(fileIndex: number, time: number, autoplay?: boolean): void;
}

export type CorrectionsSaveState = "idle" | "saving" | "saved" | "error";

const RATES = [1, 1.25, 1.5, 2];
const SKIP_SECONDS = 10;

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
  }
>(function TranscriptPlayer(
  {
    segments,
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
  },
  ref,
) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pendingSeek = useRef<{ time: number; autoplay: boolean } | null>(null);
  const programmaticScrollUntil = useRef(0);

  const [currentFile, setCurrentFile] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(true);
  const [rate, setRate] = useState(1);
  const [follow, setFollow] = useState(true);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [activeWordIndex, setActiveWordIndex] = useState(-1);
  const [audioUnavailable, setAudioUnavailable] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [editingIndex, setEditingIndex] = useState(-1);

  const applied = useMemo(() => applyCorrections(segments, corrections), [segments, corrections]);
  const shown = applied.segments;
  const correctedIndices = applied.corrected;
  const correctedRanges = applied.ranges;
  const turns = useMemo(() => computeTurns(shown), [shown]);
  const totalFiles = Math.max(fileCount, countFiles(shown));
  const withHours = useMemo(
    () => duration >= 3600 || shown.some((s) => s.end >= 3600),
    [duration, shown],
  );
  const uncertainWords = useMemo(() => countUncertainWords(shown), [shown]);
  const hasSegments = shown.length > 0;
  const hasAudio = fileCount > 0 && !audioPending;
  const canEdit = editable && typeof onCorrectionsChange === "function";

  const src = hasAudio ? audioSrcFor(currentFile) : undefined;

  useEffect(() => {
    setActiveIndex(-1);
    setActiveWordIndex(-1);
  }, [segments]);

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
    return [...set].sort();
  }, [speakerOptions, segments]);

  function syncActive(time: number) {
    const index = findActiveSegmentIndex(shown, currentFile, time);
    setActiveIndex(index);
    const words = shown[index]?.words;
    setActiveWordIndex(words ? findActiveWordIndex(words, time) : -1);
  }

  function onTimeUpdate() {
    const audio = audioRef.current;
    if (!audio) return;
    setCurrentTime(audio.currentTime);
    syncActive(audio.currentTime);
  }

  function onLoadedMetadata() {
    const audio = audioRef.current;
    if (!audio) return;
    setDuration(audio.duration);
    audio.playbackRate = rate;
    const pending = pendingSeek.current;
    if (pending) {
      pendingSeek.current = null;
      audio.currentTime = pending.time;
      syncActive(pending.time);
      if (pending.autoplay) void audio.play().catch(ignoreAbort);
    }
  }

  const seekTo = useCallback(
    (fileIndex: number, time: number, autoplay = false) => {
      if (!hasAudio) {
        setCurrentFile(fileIndex);
        setActiveIndex(findActiveSegmentIndex(shown, fileIndex, time));
        setActiveWordIndex(-1);
        return;
      }
      setFollow(true);
      const audio = audioRef.current;
      if (fileIndex !== currentFile || !audio) {
        pendingSeek.current = { time, autoplay };
        setCurrentFile(fileIndex);
        return;
      }
      audio.currentTime = time;
      setCurrentTime(time);
      syncActive(time);
      if (autoplay) void audio.play().catch(ignoreAbort);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasAudio, currentFile, shown],
  );

  useImperativeHandle(ref, () => ({ seekTo }), [seekTo]);

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(ignoreAbort);
    else audio.pause();
  }

  function skip(delta: number) {
    const audio = audioRef.current;
    if (!audio) return;
    const target = Math.min(Math.max(0, audio.currentTime + delta), audio.duration || Infinity);
    audio.currentTime = target;
    setCurrentTime(target);
    syncActive(target);
  }

  function cycleRate() {
    const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (target.closest("input, select, textarea, [contenteditable]")) return;
    if (!hasAudio) return;
    if (e.key === " " || e.key.toLowerCase() === "k") {
      e.preventDefault();
      togglePlay();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      skip(-5);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      skip(5);
    } else if (e.key.toLowerCase() === "j") {
      skip(-SKIP_SECONDS);
    } else if (e.key.toLowerCase() === "l") {
      skip(SKIP_SECONDS);
    }
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
    block.scrollIntoView({ block: "center", behavior: "smooth" });
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
    const raw = segments[segmentIndex];
    if (!raw) return;
    const trimmed = newText.replace(/\s+$/g, "");
    const occurrences = occurrencesForLine(segmentIndex, raw.text, trimmed);
    const next = withLineCorrection(corrections, segmentIndex, occurrences);
    if (JSON.stringify(next.occurrences) !== JSON.stringify(corrections.occurrences)) {
      onCorrectionsChange?.(next);
    }
  }

  function revertLine(segmentIndex: number) {
    setEditingIndex(-1);
    if (!canEdit || !corrections) return;
    onCorrectionsChange?.(withLineCorrection(corrections, segmentIndex, null));
  }

  function reassignTurn(turn: TranscriptTurn, speaker: string) {
    if (!canEdit || !corrections) return;
    let next = corrections;
    for (const part of turn.parts) {
      const stored = segments[part.segmentIndex]?.speaker;
      if (!stored) continue;
      next = withSpeakerEdit(next, part.segmentIndex, stored, speaker);
    }
    onCorrectionsChange?.(next);
  }

  if (!hasSegments) {
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
      className={cn("flex min-h-0 flex-col", className)}
      role="region"
      aria-label="Inspelning och transkript"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {hasAudio && (
        <audio
          key={`${currentFile}-${reloadKey}`}
          ref={audioRef}
          src={src}
          preload="metadata"
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={onLoadedMetadata}
          onDurationChange={() => setDuration(audioRef.current?.duration ?? 0)}
          onPlay={() => setPaused(false)}
          onPause={() => setPaused(true)}
          onError={() => setAudioUnavailable(true)}
        />
      )}

      {/* Transport */}
      <div className="flex items-center gap-2 border-b border-rule-soft px-3 py-2.5">
        <button
          type="button"
          onClick={togglePlay}
          disabled={!hasAudio || audioUnavailable}
          aria-label={paused ? "Spela" : "Pausa"}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground transition-transform active:scale-95 disabled:opacity-40"
        >
          {paused ? (
            <Play className="h-4 w-4 translate-x-[1px]" strokeWidth={2.25} fill="currentColor" />
          ) : (
            <Pause className="h-4 w-4" strokeWidth={2.25} fill="currentColor" />
          )}
        </button>

        <button
          type="button"
          onClick={() => skip(-SKIP_SECONDS)}
          disabled={!hasAudio || audioUnavailable}
          aria-label={`Bakåt ${SKIP_SECONDS} sekunder`}
          className="hidden sm:grid h-8 w-8 place-items-center rounded-full text-ink-soft hover:text-ink disabled:opacity-40"
        >
          <RotateCcw className="h-4 w-4" strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={() => skip(SKIP_SECONDS)}
          disabled={!hasAudio || audioUnavailable}
          aria-label={`Framåt ${SKIP_SECONDS} sekunder`}
          className="hidden sm:grid h-8 w-8 place-items-center rounded-full text-ink-soft hover:text-ink disabled:opacity-40"
        >
          <RotateCw className="h-4 w-4" strokeWidth={2} />
        </button>

        <span className="font-mono text-[11px] tabular-nums text-ink-soft shrink-0">
          {formatClock(currentTime, withHours)}
        </span>
        <input
          type="range"
          min={0}
          max={Number.isFinite(duration) && duration > 0 ? duration : 0}
          step={0.1}
          value={Math.min(currentTime, duration || 0)}
          disabled={!hasAudio || audioUnavailable || !duration}
          onChange={(e) => {
            const t = Number(e.target.value);
            if (audioRef.current) audioRef.current.currentTime = t;
            setCurrentTime(t);
            syncActive(t);
          }}
          aria-label="Position i inspelningen"
          className="min-w-0 flex-1 accent-[hsl(var(--accent))]"
        />
        <span className="font-mono text-[11px] tabular-nums text-ink-mute shrink-0">
          {formatClock(duration, withHours)}
        </span>

        <button
          type="button"
          onClick={cycleRate}
          disabled={!hasAudio}
          aria-label={`Hastighet ${rateLabel(rate)}`}
          className="font-mono text-[11px] tabular-nums text-ink-soft hover:text-ink rounded-full border border-rule-soft px-2 py-1 shrink-0 disabled:opacity-40"
        >
          {rateLabel(rate)}
        </button>
        {!follow && hasAudio && (
          <button
            type="button"
            onClick={() => setFollow(true)}
            className="text-[11px] text-accent hover:underline shrink-0"
          >
            Följ
          </button>
        )}
      </div>

      {totalFiles > 1 && hasAudio && (
        <div className="flex items-center gap-1.5 border-b border-rule-soft px-3 py-1.5">
          {Array.from({ length: totalFiles }, (_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => seekTo(i, 0, false)}
              aria-pressed={i === currentFile}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-[11px]",
                i === currentFile
                  ? "bg-accent text-accent-foreground"
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
              <p className="text-accent">
                Ljudet kunde inte spelas.{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => {
                    setAudioUnavailable(false);
                    setReloadKey((k) => k + 1);
                  }}
                >
                  Försök igen
                </button>
              </p>
            )}
            {uncertainWords > 0 && (
              <p className="text-ink-mute">
                {uncertainWords} ord med osäker tidsstämpel är understrukna.
              </p>
            )}
            {canEdit && !audioPending && (
              <p className="text-ink-mute">
                Hovra över en replik för att rätta texten. Klicka på talarens namn för att byta.
              </p>
            )}
          </div>
          {saveState !== "idle" && (
            <p
              className={cn(
                "shrink-0 text-[11px]",
                saveState === "error" ? "text-accent" : "text-ink-mute",
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

      {/* Transkript */}
      <div
        ref={listRef}
        onWheel={onUserScroll}
        onTouchMove={onUserScroll}
        className="min-h-0 flex-1 overflow-y-auto p-2 max-h-[60vh] lg:max-h-none"
      >
        {turns.map((turn, i) => (
          <TurnBlock
            key={turn.index}
            turn={turn}
            rawSegments={segments}
            correctedIndices={correctedIndices}
            correctedRanges={correctedRanges}
            showFileHeading={totalFiles > 1 && (i === 0 || turns[i - 1].fileIndex !== turn.fileIndex)}
            activeIndex={activeIndex}
            activeWordIndex={activeWordIndex}
            withHours={withHours}
            name={displayName(turn.speaker)}
            displayName={displayName}
            labelOptions={labelOptions}
            canEdit={canEdit}
            editingIndex={editingIndex}
            onStartEdit={(idx) => {
              audioRef.current?.pause();
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
  activeIndex,
  activeWordIndex,
  withHours,
  name,
  displayName,
  labelOptions,
  canEdit,
  editingIndex,
  onStartEdit,
  onCancelEdit,
  onCommitLine,
  onRevertLine,
  onReassign,
  onSeekTurn,
  onPartClick,
}: {
  turn: TranscriptTurn;
  rawSegments: readonly TranscriptSegment[];
  correctedIndices: ReadonlySet<number>;
  correctedRanges: ReadonlyMap<number, CorrectedRange[]>;
  showFileHeading: boolean;
  activeIndex: number;
  activeWordIndex: number;
  withHours: boolean;
  name: string;
  displayName: (label: string | null) => string;
  labelOptions: readonly string[];
  canEdit: boolean;
  editingIndex: number;
  onStartEdit: (segmentIndex: number) => void;
  onCancelEdit: () => void;
  onCommitLine: (segmentIndex: number, text: string) => void;
  onRevertLine: (segmentIndex: number) => void;
  onReassign: (speaker: string) => void;
  onSeekTurn: () => void;
  onPartClick: (part: TranscriptTurnPart, e: React.MouseEvent) => void;
}) {
  const color = speakerColor(turn.speaker);
  const isActive = turn.parts.some((p) => p.segmentIndex === activeIndex);
  const [pickingSpeaker, setPickingSpeaker] = useState(false);
  const storedSpeaker = rawSegments[turn.parts[0]?.segmentIndex ?? -1]?.speaker ?? null;
  const reassigned = storedSpeaker !== null && storedSpeaker !== turn.speaker;

  return (
    <>
      {showFileHeading && (
        <div className="px-2 pt-3 pb-1 text-[11px] text-ink-mute">Del {turn.fileIndex + 1}</div>
      )}
      <div
        data-turn-index={turn.index}
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
          {canEdit && pickingSpeaker && turn.speaker ? (
            <select
              autoFocus
              aria-label="Byt talare"
              value={turn.speaker}
              onChange={(e) => {
                onReassign(e.target.value);
                setPickingSpeaker(false);
              }}
              onBlur={() => setPickingSpeaker(false)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setPickingSpeaker(false);
              }}
              className="mt-0.5 w-full max-w-full rounded border border-rule bg-paper text-[12px] text-ink"
            >
              {labelOptions.map((label) => (
                <option key={label} value={label}>
                  {displayName(label)}
                  {label === storedSpeaker ? " (ursprunglig)" : ""}
                </option>
              ))}
            </select>
          ) : (
            <button
              type="button"
              disabled={!canEdit || !turn.speaker}
              onClick={() => setPickingSpeaker(true)}
              title={
                reassigned
                  ? `Bytt från ${displayName(storedSpeaker)}`
                  : canEdit
                    ? "Byt talare"
                    : undefined
              }
              className={cn(
                "mt-0.5 flex max-w-full items-center gap-1.5 text-left text-[12px] font-semibold leading-tight",
                canEdit && "hover:underline decoration-dotted underline-offset-2",
                "disabled:cursor-default disabled:no-underline",
              )}
              style={{ color }}
            >
              <span
                aria-hidden
                className={cn("h-2 w-2 shrink-0 rounded-full", reassigned && "ring-2 ring-offset-1 ring-offset-paper")}
                style={{ background: color, ["--tw-ring-color" as string]: color }}
              />
              <span className="truncate">{name}</span>
              {canEdit && <ChevronDown className="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-70" />}
            </button>
          )}
        </div>
        <div className="text-[14px] leading-[1.65] text-ink">
          {turn.parts.map((part) => {
            const partActive = part.segmentIndex === activeIndex;
            const corrected = correctedIndices.has(part.segmentIndex);
            const ranges = correctedRanges.get(part.segmentIndex) ?? [];
            if (editingIndex === part.segmentIndex) {
              return (
                <LineEditor
                  key={part.segmentIndex}
                  initial={part.segment.text}
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
                    partActive && "bg-accent/10",
                  )}
                >
                  {pieces(part.segment, ranges).map((piece, k) => (
                    <span
                      key={k}
                      data-word-start={piece.word ? piece.word.start : undefined}
                      className={cn(
                        "rounded-[3px]",
                        piece.word &&
                          partActive &&
                          piece.wordIndex === activeWordIndex &&
                          "bg-accent text-accent-foreground",
                        piece.word?.uncertain &&
                          "underline decoration-wavy decoration-ochre underline-offset-2",
                        piece.correctedFrom !== null &&
                          "underline decoration-dotted decoration-accent underline-offset-[3px]",
                      )}
                      title={
                        piece.correctedFrom !== null
                          ? `Rättad från: ${piece.correctedFrom}`
                          : piece.word?.uncertain
                            ? "Osäker tidsstämpel: ordet kunde inte hittas i ljudet."
                            : undefined
                      }
                    >
                      {piece.text}
                    </span>
                  ))}
                </span>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => onStartEdit(part.segmentIndex)}
                    aria-label="Rätta repliken"
                    className="mx-1 inline-grid h-5 w-5 translate-y-[3px] place-items-center rounded text-ink-mute opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover/part:opacity-100 [@media(pointer:coarse)]:opacity-60"
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
        className="w-full resize-none rounded-md border border-rule bg-paper px-2 py-1 text-[14px] leading-[1.65] text-ink focus:outline-none focus:ring-2 focus:ring-accent"
      />
      <div className="mt-1 flex items-center gap-3 text-[11px] text-ink-mute">
        <span>Enter sparar · Esc avbryter</span>
        {corrected && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onRevert}
            className="text-accent hover:underline"
          >
            Återställ originalet
          </button>
        )}
      </div>
    </div>
  );
}

function ignoreAbort(err: unknown) {
  if (err instanceof DOMException && err.name === "AbortError") return;
}
