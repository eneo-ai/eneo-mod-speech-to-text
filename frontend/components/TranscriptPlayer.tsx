"use client";

import { Pause, Play, RotateCcw, RotateCw } from "lucide-react";
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

export interface TranscriptPlayerHandle {
  /** Flyttar spelhuvudet; med `autoplay` startar även uppspelningen. */
  seekTo(fileIndex: number, time: number, autoplay?: boolean): void;
}

const RATES = [1, 1.25, 1.5, 2];
const SKIP_SECONDS = 10;

function rateLabel(rate: number): string {
  return `${String(rate).replace(".", ",")}×`;
}

export function speakerColor(label: string | null): string {
  const index = label ? speakerColorIndex(label) : 0;
  return `hsl(var(--speaker-${index}))`;
}

type Piece = { text: string; word: TranscriptWord | null; wordIndex: number };

/** Segmentets text uppdelad så att varje tidsatt ord blir sin egen bit. */
function pieces(segment: TranscriptSegment): Piece[] {
  const words = (segment.words ?? [])
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => w.charStart >= 0)
    .sort((a, b) => a.w.charStart - b.w.charStart);
  if (words.length === 0) {
    return [{ text: segment.text, word: null, wordIndex: -1 }];
  }
  const out: Piece[] = [];
  let cursor = 0;
  for (const { w, i } of words) {
    if (w.charStart < cursor) continue;
    if (w.charStart > cursor) {
      out.push({ text: segment.text.slice(cursor, w.charStart), word: null, wordIndex: -1 });
    }
    out.push({ text: segment.text.slice(w.charStart, w.charEnd), word: w, wordIndex: i });
    cursor = w.charEnd;
  }
  if (cursor < segment.text.length) {
    out.push({ text: segment.text.slice(cursor), word: null, wordIndex: -1 });
  }
  return out;
}

export const TranscriptPlayer = forwardRef<
  TranscriptPlayerHandle,
  {
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

  const turns = useMemo(() => computeTurns(segments), [segments]);
  const totalFiles = Math.max(fileCount, countFiles(segments));
  const withHours = useMemo(
    () => duration >= 3600 || segments.some((s) => s.end >= 3600),
    [duration, segments],
  );
  const uncertainWords = useMemo(() => countUncertainWords(segments), [segments]);
  const hasSegments = segments.length > 0;
  const hasAudio = fileCount > 0 && !audioPending;

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

  function syncActive(time: number) {
    const index = findActiveSegmentIndex(segments, currentFile, time);
    setActiveIndex(index);
    const words = segments[index]?.words;
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
        // Utan ljud: markera bara raden.
        setCurrentFile(fileIndex);
        setActiveIndex(findActiveSegmentIndex(segments, fileIndex, time));
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
    [hasAudio, currentFile, segments],
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
    if (!follow || activeIndex < 0 || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-turn-index][data-first-segment="${activeIndex}"], [data-segment-index="${activeIndex}"]`,
    );
    const block = el?.closest<HTMLElement>("[data-turn-index]") ?? el;
    if (!block) return;
    programmaticScrollUntil.current = Date.now() + 800;
    block.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIndex, follow]);

  function onUserScroll() {
    if (Date.now() < programmaticScrollUntil.current) return;
    if (follow) setFollow(false);
  }

  function onPartClick(part: TranscriptTurnPart, e: React.MouseEvent) {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    const wordEl = (e.target as HTMLElement).closest<HTMLElement>("[data-word-start]");
    const wordTime = wordEl ? Number(wordEl.dataset.wordStart) : Number.NaN;
    seekTo(
      part.segment.fileIndex,
      Number.isFinite(wordTime) ? wordTime : part.segment.start,
      !paused,
    );
  }

  if (!hasSegments) {
    return (
      <section
        className={cn("flex flex-col", className)}
        aria-label="Transkript"
      >
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

      {(audioPending || audioUnavailable || fileCount === 0 || uncertainWords > 0) && (
        <div className="px-3 pt-2 text-[12px] leading-relaxed">
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
            showFileHeading={totalFiles > 1 && (i === 0 || turns[i - 1].fileIndex !== turn.fileIndex)}
            activeIndex={activeIndex}
            activeWordIndex={activeWordIndex}
            withHours={withHours}
            name={displayName(turn.speaker)}
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
  showFileHeading,
  activeIndex,
  activeWordIndex,
  withHours,
  name,
  onSeekTurn,
  onPartClick,
}: {
  turn: TranscriptTurn;
  showFileHeading: boolean;
  activeIndex: number;
  activeWordIndex: number;
  withHours: boolean;
  name: string;
  onSeekTurn: () => void;
  onPartClick: (part: TranscriptTurnPart, e: React.MouseEvent) => void;
}) {
  const color = speakerColor(turn.speaker);
  const isActive = turn.parts.some((p) => p.segmentIndex === activeIndex);
  return (
    <>
      {showFileHeading && (
        <div className="px-2 pt-3 pb-1 text-[11px] text-ink-mute">Del {turn.fileIndex + 1}</div>
      )}
      <div
        data-turn-index={turn.index}
        data-first-segment={turn.parts[0]?.segmentIndex}
        className={cn(
          "grid grid-cols-[4.25rem_minmax(0,1fr)] gap-x-3 rounded-lg px-2 py-2 sm:grid-cols-[5.5rem_minmax(0,1fr)]",
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
          <div
            className="mt-0.5 flex items-center gap-1.5 text-[12px] font-semibold leading-tight"
            style={{ color }}
          >
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: color }}
            />
            <span className="truncate">{name}</span>
          </div>
        </div>
        <p className="text-[14px] leading-[1.65] text-ink">
          {turn.parts.map((part, pi) => {
            const partActive = part.segmentIndex === activeIndex;
            return (
              <span key={part.segmentIndex}>
                {pi > 0 ? " " : null}
                <span
                  data-segment-index={part.segmentIndex}
                  onClick={(e) => onPartClick(part, e)}
                  className={cn(
                    "cursor-pointer rounded-sm box-decoration-clone transition-colors",
                    partActive && "bg-accent/10",
                  )}
                >
                  {pieces(part.segment).map((piece, k) =>
                    piece.word ? (
                      <span
                        key={k}
                        data-word-start={piece.word.start}
                        className={cn(
                          "rounded-[3px]",
                          partActive && piece.wordIndex === activeWordIndex && "bg-accent text-accent-foreground",
                          piece.word.uncertain && "underline decoration-wavy decoration-ochre underline-offset-2",
                        )}
                        title={piece.word.uncertain ? "Osäker tidsstämpel: ordet kunde inte hittas i ljudet." : undefined}
                      >
                        {piece.text}
                      </span>
                    ) : (
                      <span key={k}>{piece.text}</span>
                    ),
                  )}
                </span>
              </span>
            );
          })}
        </p>
      </div>
    </>
  );
}

function ignoreAbort(err: unknown) {
  if (err instanceof DOMException && err.name === "AbortError") return;
}
