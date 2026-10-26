import { type RefObject, useEffect, useRef } from "react";
import { prefersReducedMotion } from "@/lib/motion";
import styles from "./LevelMeter.module.css";

/** 0 at −60 dBFS and below, 1 at −10 dBFS and above: speech lands in the middle. */
function levelFromRms(rms: number): number {
  const decibels = 20 * Math.log10(Math.max(rms, 1e-6));
  return Math.min(1, Math.max(0, (decibels + 60) / 50));
}

/**
 * Resumes an audio context that the browser suspends or interrupts after it has run (iOS after a call or Siri, a page in
 * the background): when its state changes, and when the page is shown again. Returns what stops it.
 */
export function keepRunning(
  context: AudioContext,
  page: Pick<Document, "addEventListener" | "removeEventListener"> | undefined = globalThis.document,
): () => void {
  const resume = () => {
    if (context.state !== "running" && context.state !== "closed") void context.resume().catch(() => undefined);
  };
  context.addEventListener("statechange", resume);
  page?.addEventListener("visibilitychange", resume);
  return () => {
    context.removeEventListener("statechange", resume);
    page?.removeEventListener("visibilitychange", resume);
  };
}

/**
 * The one audio context that reads every input level on the page. WebKit starts an audio context only in the user's
 * gesture or while the page already captures, and does not try again a start it refused: a context made when the
 * stream arrives, after the browser has asked for the microphone, stays silent for the whole recording.
 * `readyInputLevel` starts it in the press that asks for the microphone; from then on it rests while nothing is read and
 * starts again for the next stream without a gesture.
 */
let levels: AudioContext | null = null;

/** The page's level context, made by the window's own AudioContext; null where the browser gives none (too many open). */
function levelContext(): AudioContext | null {
  const AudioCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) return null;
  if (levels instanceof AudioCtor && levels.state !== "closed") return levels;
  try {
    levels = new AudioCtor();
  } catch {
    levels = null;
  }
  return levels;
}

/** In the press that asks for the microphone (Starta, Fortsätt spela in, Testa mikrofonen): the level's audio may start from here. */
export function readyInputLevel(): void {
  if (typeof window === "undefined") return;
  void levelContext()?.resume().then(rest, () => undefined);
}

/** Nothing is read: the level's audio rests, and may start again without a gesture. */
function rest() {
  if (readings.size === 0) void levels?.suspend().catch(() => undefined);
}

type LevelListener = (level: number, running: boolean, peak: number, now: number) => void;

/** The streams being read, each read once for all that listen to it (useInputLevel). */
const readings = new Map<MediaStream, { listeners: Set<RefObject<LevelListener>>; stop: () => void }>();

/** Reads `stream`'s level about fifteen times a second for `listeners`; what stops it, or null without audio for it. */
function read(stream: MediaStream, listeners: Set<RefObject<LevelListener>>): (() => void) | null {
  const context = levelContext();
  if (!context) return null;
  let source: MediaStreamAudioSourceNode;
  let analyser: AnalyserNode;
  try {
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
  } catch {
    // No audio track to read.
    return null;
  }
  void context.resume().catch(() => undefined);
  const stopResuming = keepRunning(context);
  analyser.fftSize = 1024;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let level = 0;
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    let peak = 0;
    for (const sample of samples) {
      sum += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const now = levelFromRms(Math.sqrt(sum / samples.length));
    level = Math.max(now, level * 0.85);
    for (const listener of listeners) listener.current(level, context.state === "running", peak, now);
  }, 66);
  return () => {
    clearInterval(timer);
    stopResuming();
    source.disconnect();
  };
}

/**
 * Calls `onLevel` about fifteen times a second with the input's level, which
 * rises at once and falls slowly so the display stays calm, and the read's
 * loudest sample as it is. `running` is false while the browser keeps the
 * audio context suspended and the level means nothing. Without audio for it,
 * there is no level, and the recording goes on. A stream is read once for all
 * that listen to it (the meter and the silence watch, the test's meter and its
 * "heard"): one timer, not one each, on the page's one level context.
 */
export function useInputLevel(
  stream: MediaStream | null,
  /** `level` glides down for the display; `now` is this read's own level, the evidence that sound is coming in now. */
  onLevel: LevelListener,
): void {
  const listener = useRef(onLevel);
  listener.current = onLevel;

  useEffect(() => {
    if (!stream) return;
    let reading = readings.get(stream);
    if (!reading) {
      const listeners = new Set<RefObject<LevelListener>>();
      const stop = read(stream, listeners);
      if (!stop) return;
      reading = { listeners, stop };
      readings.set(stream, reading);
    }
    const { listeners, stop } = reading;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        stop();
        readings.delete(stream);
        rest();
      }
      // Paused or gone: the display settles instead of freezing mid-word.
      listener.current(0, false, 0, 0);
    };
  }, [stream]);
}

/**
 * A calm level display: bars that light up with the input's level ("steps")
 * or a waveform that breathes with it ("wave"). Decorative for assistive
 * technology; the status in words carries the meaning. With reduced motion it
 * still shows the level, the live proof that the microphone hears, but jumps
 * between levels instead of gliding, and the wave does not sway.
 */
export function LevelMeter({
  stream,
  bars,
  variant,
  even = false,
  className,
}: {
  stream: MediaStream | null;
  bars: number;
  variant: "steps" | "wave";
  /** Steps of one height (the container's), lit from the start: a level across a row, rather than a rising staircase. */
  even?: boolean;
  className?: string;
}) {
  const elements = useRef<Array<HTMLSpanElement | null>>([]);
  const still = useRef(false);

  useEffect(() => {
    still.current = prefersReducedMotion();
  }, []);

  useInputLevel(stream, (level) => {
    elements.current.forEach((element, index) => {
      if (!element) return;
      if (variant === "steps") {
        element.dataset.lit = String(index < Math.round(level * bars));
      } else {
        // Taller in the middle, each bar at its own slight offset.
        const shape = 1 - Math.abs(index - (bars - 1) / 2) / (bars / 2);
        const wobble = still.current ? 1 : 0.75 + 0.25 * Math.sin(Date.now() / 180 + index * 1.7);
        element.style.transform = `scaleY(${Math.max(0.12, level * shape * wobble)})`;
      }
    });
  });

  return (
    <div aria-hidden className={[styles.meter, styles[variant], className].filter(Boolean).join(" ")}>
      {Array.from({ length: bars }, (_, index) => (
        <span
          key={index}
          ref={(element) => {
            elements.current[index] = element;
          }}
          data-lit="false"
          className={styles.bar}
          style={variant === "steps" ? { height: even ? "100%" : `${40 + (60 * (index + 1)) / bars}%` } : undefined}
        />
      ))}
    </div>
  );
}
