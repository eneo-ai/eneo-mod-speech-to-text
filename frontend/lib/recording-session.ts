/**
 * Captures audio into the recording store, one part (one audio file) per
 * MediaRecorder run. Losing the microphone pauses the recording: its track
 * ends or is muted (a phone call, a phone putting the page in the background)
 * or the recorder stops or fails by itself. `continueRecording()` then starts
 * a new part of the same recording on a fresh microphone stream. A hidden page
 * flushes the current chunk, so a page the system kills loses as little as
 * possible; hiding alone does not pause, since a laptop keeps recording in a
 * background tab.
 */

import type { NewRecording, RecordingStore, StoredRecording } from "./recording-store";
import { formatBytes } from "./upload";

export const CHUNK_MS = 2_000;

/**
 * Speech, not music: one channel at 32 kbit/s, Opus where the browser records
 * it and its own format otherwise (Safari: audio/mp4, see the recorder's
 * format choice). A 5-hour meeting is then about 72 MB (32 kbit/s for
 * 18,000 s), well under a flow's per-file limit, and speech stays clearly
 * intelligible.
 */
export const SPEECH_RECORDING = { channelCount: 1, audioBitsPerSecond: 32_000 } as const;
// Re-read the storage estimate about once a minute.
const SPACE_CHECK_EVERY_CHUNKS = 30;

export type CaptureStatus = "idle" | "recording" | "paused" | "interrupted" | "stopped";

export interface CaptureSnapshot {
  status: CaptureStatus;
  recording: StoredRecording | null;
  /** The microphone stream of the running part, for a level meter. */
  stream: MediaStream | null;
  partBytes: number;
  error: string | null;
  lowSpace: boolean;
  persistent: boolean;
}

export interface WakeLockLike {
  release(): Promise<void>;
}

export interface PageLike {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface CaptureDeps {
  getStream(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createRecorder(stream: MediaStream, options: MediaRecorderOptions): MediaRecorder;
  requestWakeLock?(): Promise<WakeLockLike | null>;
  page?: PageLike;
  now?(): number;
}

type EndReason = "stop" | "interrupt" | "leave";

function microphoneError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Tillåt mikrofonen i webbläsaren för att spela in.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "Ingen mikrofon hittades.";
  }
  return "Mikrofonen kunde inte startas. Försök igen.";
}

export class RecordingCapture {
  private snapshot: CaptureSnapshot = {
    status: "idle",
    recording: null,
    stream: null,
    partBytes: 0,
    error: null,
    lowSpace: false,
    persistent: true,
  };
  private listeners = new Set<() => void>();
  private store: RecordingStore | null = null;
  private recorder: MediaRecorder | null = null;
  private release: (() => void) | null = null;
  private wakeLock: WakeLockLike | null = null;
  private starting = false;
  // Bumped when the page goes away; a start begun before that must not record.
  private generation = 0;
  private ending: EndReason | null = null;
  private partEnded: Promise<void> = Promise.resolve();
  private maxBytes: number | undefined;
  // Recorded time on a monotonic clock, never by counting timer ticks (hidden
  // tabs throttle timers): earlier parts, this part before its latest pause,
  // and the running stretch.
  private earlierPartsMs = 0;
  private partMs = 0;
  private runningSince: number | null = null;

  /** `openStore` is called on the first start, never while rendering. */
  constructor(
    private readonly openStore: () => RecordingStore | Promise<RecordingStore>,
    private readonly deps: CaptureDeps,
  ) {}

  getSnapshot = (): CaptureSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  elapsedMs(): number {
    return this.earlierPartsMs + this.partElapsed();
  }

  async start(init: NewRecording, { maxBytes }: { maxBytes?: number } = {}): Promise<void> {
    const { status } = this.snapshot;
    if (this.starting || (status !== "idle" && status !== "stopped")) return;
    this.starting = true;
    this.set({ error: null });
    const generation = this.generation;
    let created: StoredRecording | null = null;
    try {
      const stream = await this.deps.getStream({
        audio: { channelCount: SPEECH_RECORDING.channelCount },
      });
      if (this.left(generation, stream)) return;
      const store = (this.store ??= await this.openStore());
      const recording = (created = await store.create(init));
      this.release = () => store.release(recording.id);
      void store.requestPersistence();
      this.maxBytes = maxBytes;
      this.earlierPartsMs = 0;
      this.set({ recording, lowSpace: await store.lowOnSpace(), persistent: store.persistent });
      this.deps.page?.addEventListener("visibilitychange", this.onVisibilityChange);
      await this.beginPart(stream);
      if (generation !== this.generation) this.dispose();
    } catch (error) {
      this.finish();
      // Nothing was recorded: do not leave an empty recording to recover.
      if (created) await this.store?.remove(created.id).catch(() => undefined);
      this.set({ status: "idle", recording: null, error: microphoneError(error) });
    } finally {
      this.starting = false;
    }
  }

  /** "Fortsätt spela in" after an interruption: a new part of the same recording. */
  async continueRecording(): Promise<void> {
    if (this.starting || this.snapshot.status !== "interrupted") return;
    this.starting = true;
    this.set({ error: null });
    const generation = this.generation;
    try {
      const stream = await this.deps.getStream({
        audio: { channelCount: SPEECH_RECORDING.channelCount },
      });
      if (this.left(generation, stream)) return;
      await this.beginPart(stream);
    } catch (error) {
      this.set({ error: microphoneError(error) });
    } finally {
      this.starting = false;
    }
  }

  togglePause(): void {
    const recorder = this.recorder;
    if (recorder?.state === "recording") {
      recorder.pause();
      this.partMs = this.partElapsed();
      this.runningSince = null;
      this.set({ status: "paused" });
    } else if (recorder?.state === "paused") {
      recorder.resume();
      this.runningSince = this.now();
      this.set({ status: "recording" });
    }
  }

  async stop(): Promise<StoredRecording | null> {
    const { recording, status } = this.snapshot;
    const store = this.store;
    if (!recording || !store || status === "idle" || status === "stopped") return null;
    await this.endPart("stop");
    await store.setState(recording.id, "stopped");
    const stopped = await store.get(recording.id);
    this.finish();
    this.set({ status: "stopped", recording: stopped, stream: null });
    return stopped;
  }

  /** "Spela in på nytt": the stored recording stays until it is sent or deleted. */
  reset(): void {
    if (this.snapshot.status === "stopped") {
      this.set({ status: "idle", recording: null, partBytes: 0, error: null });
    }
  }

  /** The page goes away: what was recorded stays, paused, for recovery. */
  dispose(): void {
    this.generation += 1;
    const { recording, status } = this.snapshot;
    const store = this.store;
    if (!recording || !store || status === "idle" || status === "stopped") return;
    void this.endPart("leave")
      .then(() => store.setState(recording.id, "paused"))
      .finally(() => this.finish());
  }

  private async beginPart(stream: MediaStream): Promise<void> {
    const store = this.store!;
    const { id, mimeType } = this.snapshot.recording!;
    let recorder: MediaRecorder;
    let part: number;
    try {
      recorder = this.deps.createRecorder(stream, {
        mimeType,
        audioBitsPerSecond: SPEECH_RECORDING.audioBitsPerSecond,
      });
      part = await store.startPart(id);
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      throw error;
    }

    const tracks = stream.getAudioTracks();
    let partBytes = 0;
    let chunks = 0;
    let ended = () => {};
    this.partEnded = new Promise((resolve) => (ended = resolve));
    const lose = () => void this.endPart("interrupt");

    const onData = (event: Event) => {
      const data = (event as BlobEvent).data;
      if (!data || data.size === 0) return;
      partBytes += data.size;
      chunks += 1;
      void store.append(id, part, data, this.partElapsed()).then(() => {
        if (store.persistent !== this.snapshot.persistent) this.set({ persistent: store.persistent });
      });
      if (chunks % SPACE_CHECK_EVERY_CHUNKS === 0) {
        void store.lowOnSpace().then((lowSpace) => lowSpace !== this.snapshot.lowSpace && this.set({ lowSpace }));
      }
      this.set({ partBytes });
      // Stop while the last chunk still fits: a larger part could not be sent.
      if (this.maxBytes && partBytes + 2 * data.size > this.maxBytes) {
        this.set({
          error: `Inspelningen stoppades vid flödets gräns på ${formatBytes(this.maxBytes)}. Det som spelats in är sparat.`,
        });
        void this.stop();
      }
    };

    const onStop = async () => {
      // A stop nobody asked for means the microphone went away.
      const reason = this.ending ?? "interrupt";
      tracks.forEach((track) => {
        track.removeEventListener("ended", lose);
        track.removeEventListener("mute", lose);
        track.stop();
      });
      recorder.removeEventListener("dataavailable", onData);
      recorder.removeEventListener("error", lose);
      recorder.removeEventListener("stop", onStop);
      this.earlierPartsMs += this.partElapsed();
      this.partMs = 0;
      this.runningSince = null;
      this.recorder = null;
      this.releaseWakeLock();
      if (reason === "interrupt") {
        await store.setState(id, "paused");
        this.set({ status: "interrupted", stream: null, recording: await store.get(id) });
      }
      ended();
    };

    tracks.forEach((track) => {
      track.addEventListener("ended", lose);
      track.addEventListener("mute", lose);
    });
    recorder.addEventListener("dataavailable", onData);
    recorder.addEventListener("error", lose);
    recorder.addEventListener("stop", onStop);
    this.recorder = recorder;
    this.ending = null;
    recorder.start(CHUNK_MS);
    this.partMs = 0;
    this.runningSince = this.now();
    this.set({ status: "recording", stream, partBytes: 0 });
    await this.takeWakeLock();
  }

  /** True, with the microphone let go, when the page went away during a start. */
  private left(generation: number, stream: MediaStream): boolean {
    if (generation === this.generation) return false;
    stream.getTracks().forEach((track) => track.stop());
    return true;
  }

  private endPart(reason: EndReason): Promise<void> {
    this.ending ??= reason;
    try {
      if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    } catch {
      // Already stopping.
    }
    return this.partEnded;
  }

  private onVisibilityChange = () => {
    const { status, stream } = this.snapshot;
    if (status !== "recording" && status !== "paused") return;
    if (this.deps.page?.visibilityState === "hidden") {
      // A phone may freeze or kill a hidden page: store what is recorded so far.
      try {
        this.recorder?.requestData();
      } catch {
        // Nothing to flush.
      }
      return;
    }
    // The wake lock ended with the hidden page; the microphone may have too.
    void this.takeWakeLock();
    const lost =
      this.recorder?.state === "inactive" ||
      stream?.getAudioTracks().some((track) => track.readyState === "ended" || track.muted);
    if (lost) void this.endPart("interrupt");
  };

  private async takeWakeLock() {
    this.releaseWakeLock();
    try {
      const lock = (await this.deps.requestWakeLock?.()) ?? null;
      if (this.recorder) this.wakeLock = lock;
      else void lock?.release().catch(() => undefined);
    } catch {
      // No wake lock (unsupported, or the page is hidden): recording goes on.
    }
  }

  private releaseWakeLock() {
    const lock = this.wakeLock;
    this.wakeLock = null;
    void lock?.release().catch(() => undefined);
  }

  private partElapsed(): number {
    return this.partMs + (this.runningSince == null ? 0 : this.now() - this.runningSince);
  }

  private now(): number {
    return this.deps.now?.() ?? performance.now();
  }

  private finish() {
    this.deps.page?.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.release?.();
    this.release = null;
    this.releaseWakeLock();
  }

  private set(patch: Partial<CaptureSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}
