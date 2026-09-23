"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/** 0 at −60 dBFS and below, 1 at −10 dBFS and above: speech lands in the middle. */
export function levelFromRms(rms: number): number {
  const decibels = 20 * Math.log10(Math.max(rms, 1e-6));
  return Math.min(1, Math.max(0, (decibels + 60) / 50));
}

/**
 * Calls `onLevel` about fifteen times a second with the input's level, which
 * rises at once and falls slowly so the display stays calm. `running` is false
 * while the browser keeps the audio context suspended and the level means
 * nothing.
 */
export function useInputLevel(
  stream: MediaStream | null,
  onLevel: (level: number, running: boolean) => void,
): void {
  const listener = useRef(onLevel);
  listener.current = onLevel;

  useEffect(() => {
    const AudioCtor =
      typeof window === "undefined"
        ? undefined
        : (window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!stream || !AudioCtor) return;
    const context = new AudioCtor();
    void context.resume().catch(() => undefined);
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let level = 0;
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      level = Math.max(levelFromRms(Math.sqrt(sum / samples.length)), level * 0.85);
      listener.current(level, context.state === "running");
    }, 66);
    return () => {
      clearInterval(timer);
      source.disconnect();
      void context.close().catch(() => undefined);
    };
  }, [stream]);
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A calm level display: bars that light up with the input's level ("steps")
 * or a waveform that breathes with it ("wave"). Decorative for assistive
 * technology; the status in words carries the meaning. With reduced motion it
 * stays still.
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
    if (still.current) return;
    elements.current.forEach((element, index) => {
      if (!element) return;
      if (variant === "steps") {
        element.dataset.lit = String(index < Math.round(level * bars));
      } else {
        // Taller in the middle, each bar at its own slight offset.
        const shape = 1 - Math.abs(index - (bars - 1) / 2) / (bars / 2);
        const wobble = 0.75 + 0.25 * Math.sin(Date.now() / 180 + index * 1.7);
        element.style.transform = `scaleY(${Math.max(0.12, level * shape * wobble)})`;
      }
    });
  });

  return (
    <div aria-hidden className={cn("flex items-center", variant === "steps" ? "gap-1" : "gap-[5px]", className)}>
      {Array.from({ length: bars }, (_, index) => (
        <span
          key={index}
          ref={(element) => {
            elements.current[index] = element;
          }}
          data-lit="false"
          className={cn(
            "block w-[3px] shrink-0 rounded-full",
            variant === "steps"
              ? "bg-rule-soft transition-colors duration-100 data-[lit=true]:bg-accent"
              : "h-full origin-center scale-y-[0.12] bg-accent transition-transform duration-75",
          )}
          style={variant === "steps" ? { height: `${40 + (60 * (index + 1)) / bars}%` } : undefined}
        />
      ))}
    </div>
  );
}
