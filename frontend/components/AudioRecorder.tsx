"use client";

import {
  Download,
  MoreHorizontal,
  Mic,
  Pause,
  Play,
  RotateCcw,
} from "lucide-react";
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from "react";
import { useAuthenticatedUser } from "@/components/AuthGate";
import {
  RecordingInterrupted,
  RecordingStorageNotice,
} from "@/components/RecordingNotices";
import { saveRecordingAsFiles } from "@/components/save-recording";
import { RecordingCapture, type CaptureDeps } from "@/lib/recording-session";
import { recordingStore, type StoredRecording } from "@/lib/recording-store";
import { formatBytes, formatDuration } from "@/lib/format";
import { pickSupportedAudioMimetype } from "@/lib/upload";

type WakeLockSentinelLike = {
  release: () => Promise<void>;
};

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: {
    request: (type: "screen") => Promise<WakeLockSentinelLike>;
  };
};

export interface AudioRecorderHandle {
  /** Takes over a recording cut off by a reload and records on in a new part. */
  continueRecording: (recording: StoredRecording) => Promise<void>;
}

interface Props {
  ref?: Ref<AudioRecorderHandle>;
  flowId: string;
  flowName: string;
  stepId: string;
  acceptedMimetypes?: string[];
  maxBytes?: number;
  /** Files the flow takes per run; a full file goes on in a new part until these run out. */
  maxFiles?: number;
  /** The recording chosen as the run's input, shown as done. */
  recording: StoredRecording | null;
  onChange: (recording: StoredRecording | null) => void;
  onRecordingChange?: (recording: boolean) => void;
  /** Optional title shown above timer while recording (e.g. flow name) */
  title?: string;
  /** Optional subtitle (e.g. flow type) */
  subtitle?: string;
}

function pickMimetype(accepted: string[] | undefined): string | null {
  if (typeof window === "undefined" || !("MediaRecorder" in window)) return null;
  return pickSupportedAudioMimetype(accepted, (mime) =>
    MediaRecorder.isTypeSupported(mime),
  );
}

function browserCaptureDeps(): CaptureDeps {
  return {
    getStream: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createRecorder: (stream, options) => new MediaRecorder(stream, options),
    requestWakeLock: async () =>
      (await (navigator as NavigatorWithWakeLock).wakeLock?.request("screen")) ?? null,
    page: typeof document === "undefined" ? undefined : document,
  };
}

const NUM_BARS = 36;

export function AudioRecorder({
  ref,
  flowId,
  flowName,
  stepId,
  acceptedMimetypes,
  maxBytes,
  maxFiles,
  recording,
  onChange,
  onRecordingChange,
  title,
  subtitle,
}: Props) {
  const user = useAuthenticatedUser();
  const [capture] = useState(
    () => new RecordingCapture(recordingStore, browserCaptureDeps()),
  );
  const snapshot = useSyncExternalStore(
    capture.subscribe,
    capture.getSnapshot,
    capture.getSnapshot,
  );
  const { status } = snapshot;
  const capturing =
    status === "recording" || status === "paused" || status === "interrupted";

  const [elapsedMs, setElapsedMs] = useState(0);
  const [supported, setSupported] = useState(true);
  const [formatError, setFormatError] = useState<string | null>(null);
  const [storePersistent, setStorePersistent] = useState(true);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);

  useImperativeHandle(
    ref,
    () => ({
      async continueRecording(recording) {
        await capture.adopt(recording.id, { maxBytes, maxFiles });
        await capture.continueRecording();
      },
    }),
    [capture, maxBytes, maxFiles],
  );

  const barsRef = useRef<Array<HTMLDivElement | null>>([]);
  const liveValuesRef = useRef<number[]>(new Array(NUM_BARS).fill(0));

  useEffect(() => {
    const mime = pickMimetype(acceptedMimetypes);
    setSupported(mime != null);
  }, [acceptedMimetypes]);

  useEffect(() => {
    recordingStore().then((store) => setStorePersistent(store.persistent));
  }, []);

  // Leaving the page keeps what was recorded, paused, for recovery.
  useEffect(() => () => capture.dispose(), [capture]);

  useEffect(() => {
    onRecordingChange?.(capturing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing]);
  useEffect(
    () => () => onRecordingChange?.(false),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // A stop from the user or from the size limit hands the recording to the page.
  useEffect(() => {
    if (status === "stopped" && snapshot.recording) onChange(snapshot.recording);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, snapshot.recording]);

  useEffect(() => {
    if (!capturing) return;
    setElapsedMs(capture.elapsedMs());
    if (status !== "recording") return;
    const tick = setInterval(() => setElapsedMs(capture.elapsedMs()), 80);
    return () => clearInterval(tick);
  }, [capture, capturing, status]);

  useEffect(() => {
    const stream = snapshot.stream;
    if (!stream) return;
    const AudioCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtor) return;
    const ctx = new AudioCtor();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.55;
    source.connect(analyser);
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;

    const draw = () => {
      analyser.getByteFrequencyData(dataArray);
      const bins = dataArray.length;
      const step = Math.max(1, Math.floor(bins / NUM_BARS));
      for (let i = 0; i < NUM_BARS; i++) {
        let sum = 0;
        const start = i * step;
        const end = Math.min(start + step, bins);
        for (let k = start; k < end; k++) sum += dataArray[k];
        const avg = sum / Math.max(1, end - start);
        const norm = Math.min(1, Math.pow(avg / 255, 0.65));
        liveValuesRef.current[i] =
          liveValuesRef.current[i] * 0.55 + norm * 0.45;
        const v = liveValuesRef.current[i];
        const el = barsRef.current[i];
        if (el) {
          const minH = 4;
          const maxH = 70;
          const h = minH + v * (maxH - minH);
          el.style.height = `${h}px`;
          const distFromCenter = Math.abs(i - NUM_BARS / 2) / (NUM_BARS / 2);
          el.style.opacity = `${0.4 + (1 - distFromCenter) * 0.6}`;
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      try {
        source.disconnect();
      } catch {
        // ignore
      }
      ctx.close().catch(() => {});
      clearMeter();
    };
  }, [snapshot.stream]);

  // Förhandslyssning av varje del av den valda inspelningen.
  useEffect(() => {
    if (!recording || capturing) {
      setPreviewUrls([]);
      return;
    }
    let cancelled = false;
    let urls: string[] = [];
    recordingStore()
      .then((store) => store.readParts(recording.id))
      .then((files) => {
        if (cancelled) return;
        urls = files.map((file) => URL.createObjectURL(file.blob));
        setPreviewUrls(urls);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [recording, capturing]);

  function clearMeter() {
    liveValuesRef.current = new Array(NUM_BARS).fill(0);
    barsRef.current.forEach((el) => {
      if (el) {
        el.style.height = "6px";
        el.style.opacity = "0.4";
      }
    });
  }

  async function start() {
    setFormatError(null);
    const mime = pickMimetype(acceptedMimetypes);
    if (!mime) {
      setFormatError(
        "Webbläsaren stöder inget ljudformat som det här flödet tar emot.",
      );
      return;
    }
    await capture.start(
      { ownerId: user.id, flowId, flowName, stepId, inputMode: "record", mimeType: mime },
      { maxBytes, maxFiles },
    );
  }

  function recordAgain() {
    capture.reset();
    onChange(null);
  }

  const error = formatError ?? snapshot.error;
  const errorLine = error && (
    <p className="text-sm text-record text-center mt-3" role="alert">
      {error}
    </p>
  );

  if (!supported) {
    return (
      <p className="text-sm text-ink-soft">
        Webbläsaren stöder inte ljudinspelning för det här flödet. Använd
        filuppladdningen istället.
      </p>
    );
  }

  // ----- Idle (pre-recording) -----
  if (!capturing && !recording) {
    return (
      <div className="flex flex-col items-center gap-7 md:gap-9 py-4 md:py-6">
        <button
          type="button"
          onClick={start}
          aria-label="Starta inspelning"
          className="relative grid place-items-center h-[116px] w-[116px] md:h-[140px] md:w-[140px] rounded-full bg-record text-record-foreground text-[16px] md:text-[18px] font-semibold tracking-[-0.01em] transition-transform active:scale-[0.96] focus:outline-none"
          style={{
            boxShadow:
              "0 0 0 6px hsl(var(--bg)), 0 0 0 7px hsl(var(--record)), 0 18px 40px -10px hsl(var(--record) / 0.18)",
          }}
        >
          <span
            aria-hidden
            className="lyssna-pulse-ring absolute rounded-full border border-record"
            style={{ inset: 0, opacity: 0 }}
          />
          Spela in
        </button>
        <div className="eyebrow">Tryck för att börja</div>
        <RecordingStorageNotice persistent={storePersistent} lowSpace={false} />
        {errorLine}
      </div>
    );
  }

  // ----- Done (recorded) -----
  if (!capturing && recording) {
    const totalBytes = recording.parts.reduce((sum, part) => sum + part.bytes, 0);
    return (
      <div className="flex flex-col items-center gap-4 py-3">
        <div className="text-[13px] text-ink-soft">
          Inspelning klar · {formatDuration(recording.durationMs)} · {formatBytes(totalBytes)}
          {recording.parts.length > 1 ? ` · ${recording.parts.length} delar` : ""}
        </div>
        {previewUrls.map((url, index) => (
          <audio
            key={url}
            src={url}
            controls
            aria-label={
              previewUrls.length > 1 ? `Lyssna på del ${index + 1}` : "Lyssna på inspelningen"
            }
            className="w-full max-w-[300px] md:max-w-md"
          />
        ))}
        <div className="text-[12px] text-ink-mute">
          {storePersistent
            ? "Sparad på enheten tills den är skickad"
            : "Sparad i den här fliken tills den är skickad"}
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={() => void saveRecordingAsFiles(recording.id)}
            className="inline-flex items-center gap-2 rounded-full bg-paper border border-rule-soft px-4 py-2 text-[13px] text-ink-soft transition-colors hover:border-ink/40"
          >
            <Download className="h-3.5 w-3.5" />
            Spara som fil
          </button>
          <button
            type="button"
            onClick={recordAgain}
            className="inline-flex items-center gap-2 rounded-full bg-paper border border-rule-soft px-4 py-2 text-[13px] text-ink-soft transition-colors hover:border-ink/40"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Spela in på nytt
          </button>
        </div>
        {errorLine}
      </div>
    );
  }

  // ----- Recording (active, paused or interrupted) -----
  const interrupted = status === "interrupted";
  const totalSec = Math.floor(elapsedMs / 1000);
  const mm = Math.floor(totalSec / 60).toString().padStart(2, "0");
  const ss = (totalSec % 60).toString().padStart(2, "0");
  const ff = Math.floor((elapsedMs % 1000) / 10).toString().padStart(2, "0");

  return (
    <div className="flex flex-col items-stretch -mx-6 px-6 md:px-8 rec-bg rounded-2xl py-5 md:py-8">
      <header className="flex items-center mb-2">
        <div className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.18em] uppercase text-record">
          <span
            aria-hidden
            className="lyssna-live-pulse h-1.5 w-1.5 rounded-full bg-record"
          />
          {status === "recording" ? "Spelar in" : "Pausad"}
        </div>
      </header>

      <div className="flex flex-col items-center justify-center px-2 pt-4 md:pt-6 pb-6">
        {(title || subtitle) && (
          <div className="text-center mb-7 md:mb-9">
            {title && (
              <div className="text-[19px] md:text-[26px] font-semibold tracking-[-0.015em] leading-tight">
                {title}
              </div>
            )}
            {subtitle && (
              <div className="font-mono text-[10px] md:text-[11px] tracking-[0.14em] uppercase text-ink-mute mt-1.5 md:mt-2">
                {subtitle}
              </div>
            )}
          </div>
        )}

        <div
          className="font-semibold tracking-[-0.045em] tabular-nums leading-none mb-7 md:mb-9 text-[84px] md:text-[112px]"
          style={{ letterSpacing: "-0.045em" }}
        >
          {mm}:{ss}
          <span className="text-[0.32em] text-ink-mute align-top ml-px">
            :{ff}
          </span>
        </div>

        <div className="text-[12px] text-ink-mute mb-4">
          {formatBytes(snapshot.recordedBytes)} ·{" "}
          {snapshot.persistent ? "sparas på enheten" : "sparas i den här fliken"}
        </div>

        <div className="flex items-center gap-[3px] md:gap-1 h-20 md:h-24 w-full max-w-[280px] md:max-w-md justify-center mb-2">
          {Array.from({ length: NUM_BARS }).map((_, i) => (
            <div
              key={i}
              ref={(el) => {
                barsRef.current[i] = el;
              }}
              className="w-[3px] rounded-[2px] bg-ink"
              style={{ height: "6px", opacity: 0.4 }}
              aria-hidden
            />
          ))}
        </div>
      </div>

      <RecordingInterrupted
        interrupted={interrupted}
        onContinue={() => void capture.continueRecording()}
      />

      <div className="flex items-center justify-center gap-7 pt-4">
        <button
          type="button"
          onClick={() => capture.togglePause()}
          disabled={interrupted}
          aria-label={status === "paused" ? "Återuppta inspelning" : "Pausa inspelning"}
          className="grid h-12 w-12 place-items-center rounded-full bg-paper border border-rule text-ink transition-colors hover:border-ink/40 focus:outline-none focus-visible:ring-4 focus-visible:ring-record/30 disabled:opacity-50"
        >
          {status === "paused" ? (
            <Play className="h-[18px] w-[18px]" strokeWidth={1.5} />
          ) : (
            <Pause className="h-[18px] w-[18px]" strokeWidth={1.5} />
          )}
        </button>
        <button
          type="button"
          onClick={() => void capture.stop()}
          aria-label="Stoppa inspelning"
          className="relative grid h-[84px] w-[84px] place-items-center rounded-full bg-record transition-transform active:scale-[0.96] focus:outline-none focus-visible:ring-4 focus-visible:ring-record/30"
          style={{
            boxShadow: "0 12px 28px -8px hsl(var(--record) / 0.18)",
          }}
        >
          <span
            aria-hidden
            className="lyssna-pulse-ring absolute rounded-full border border-record"
            style={{ inset: 0, opacity: 0 }}
          />
          <span className="block h-6 w-6 rounded-[4px] bg-record-foreground" />
        </button>
        <button
          type="button"
          aria-label="Mer"
          disabled
          className="grid h-12 w-12 place-items-center rounded-full bg-paper border border-rule text-ink-soft opacity-50"
        >
          <MoreHorizontal className="h-[18px] w-[18px]" strokeWidth={1.5} />
        </button>
      </div>

      <RecordingStorageNotice
        persistent={snapshot.persistent}
        lowSpace={snapshot.lowSpace}
      />
      {errorLine}

      {/* Hidden hint icon for screen readers — visual cue is the pulse-ring */}
      <span className="sr-only">
        <Mic /> Spelar in ljud
      </span>
    </div>
  );
}
