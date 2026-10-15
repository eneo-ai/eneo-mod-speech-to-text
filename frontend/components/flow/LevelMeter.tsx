import { useEffect, useRef } from "react";
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

/** The input through an analyser, or null where the browser gives no audio for it (too many contexts, no audio track). */
function analyse(AudioCtor: typeof AudioContext, stream: MediaStream) {
  let context: AudioContext | null = null;
  try {
    context = new AudioCtor();
    const source = context.createMediaStreamSource(stream);
    return { context, source, analyser: context.createAnalyser() };
  } catch {
    void context?.close().catch(() => undefined);
    return null;
  }
}

/**
 * Calls `onLevel` about fifteen times a second with the input's level, which
 * rises at once and falls slowly so the display stays calm, and the read's
 * loudest sample as it is. `running` is false while the browser keeps the
 * audio context suspended and the level means nothing. Without audio for it,
 * there is no level, and the recording goes on.
 */
export function useInputLevel(
  stream: MediaStream | null,
  onLevel: (level: number, running: boolean, peak: number) => void,
): void {
  const listener = useRef(onLevel);
  listener.current = onLevel;

  useEffect(() => {
    const AudioCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    const audio = stream && AudioCtor ? analyse(AudioCtor, stream) : null;
    if (!audio) return;
    const { context, source, analyser } = audio;
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
      level = Math.max(levelFromRms(Math.sqrt(sum / samples.length)), level * 0.85);
      listener.current(level, context.state === "running", peak);
    }, 66);
    return () => {
      clearInterval(timer);
      stopResuming();
      source.disconnect();
      void context.close().catch(() => undefined);
      // Paused or gone: the display settles instead of freezing mid-word.
      listener.current(0, false, 0);
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
  className,
}: {
  stream: MediaStream | null;
  bars: number;
  variant: "steps" | "wave";
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
          style={variant === "steps" ? { height: `${40 + (60 * (index + 1)) / bars}%` } : undefined}
        />
      ))}
    </div>
  );
}
