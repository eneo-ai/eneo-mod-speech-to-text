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

import {
  continuable,
  IN_USE_ELSEWHERE,
  type NewRecording,
  type RecordingStore,
  type StoredRecording,
} from "./recording-store";
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
  /** Every part's bytes, the running one included. */
  recordedBytes: number;
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

/** The flow's limits for the audio step: bytes per file and files per run. */
export interface CaptureLimits {
  maxBytes?: number;
  maxFiles?: number;
}

type EndReason = "stop" | "interrupt" | "leave" | "rotate";

const NOT_CONTINUABLE = "Inspelningen är avslutad och kan inte fortsätta.";

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
    recordedBytes: 0,
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
  private limits: CaptureLimits = {};
  // Parts the recording has, the running one included, and the bytes of those before it.
  private partCount = 0;
  private earlierPartsBytes = 0;
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

  async start(init: NewRecording, limits: CaptureLimits = {}): Promise<void> {
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
      this.limits = limits;
      this.partCount = 0;
      this.earlierPartsBytes = 0;
      this.earlierPartsMs = 0;
      this.set({ recording, lowSpace: await store.lowOnSpace(), persistent: store.persistent });
      this.deps.page?.addEventListener("visibilitychange", this.onVisibilityChange);
      await this.beginPart(stream);
      await this.takeWakeLock();
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

  /**
   * Takes over a recording whose capture ended without a stop (the tab was
   * reloaded or killed), paused: "Fortsätt spela in" then adds a part to the
   * same recording, so the meeting still becomes one run.
   */
  async adopt(recordingId: string, limits: CaptureLimits = {}): Promise<void> {
    const { status } = this.snapshot;
    if (this.starting || (status !== "idle" && status !== "stopped")) return;
    this.starting = true;
    this.set({ error: null });
    const generation = this.generation;
    try {
      const store = (this.store ??= await this.openStore());
      const found = await store.get(recordingId);
      if (!found || !continuable(found)) throw new Error(NOT_CONTINUABLE);
      if (!(await store.lease(recordingId))) throw new Error(IN_USE_ELSEWHERE);
      if (generation !== this.generation) {
        store.release(recordingId);
        return;
      }
      this.release = () => store.release(recordingId);
      await store.setState(recordingId, "paused");
      this.limits = limits;
      this.earlierPartsBytes = found.parts.reduce((sum, part) => sum + part.bytes, 0);
      this.earlierPartsMs = found.durationMs;
      this.partMs = 0;
      this.runningSince = null;
      this.deps.page?.addEventListener("visibilitychange", this.onVisibilityChange);
      this.set({
        status: "interrupted",
        recording: await store.get(recordingId),
        stream: null,
        partBytes: 0,
        recordedBytes: this.earlierPartsBytes,
        lowSpace: await store.lowOnSpace(),
        persistent: store.persistent,
      });
    } catch (error) {
      this.finish();
      const known = error instanceof Error && [NOT_CONTINUABLE, IN_USE_ELSEWHERE].includes(error.message);
      this.set({ error: known ? error.message : "Inspelningen kunde inte öppnas." });
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
      await this.takeWakeLock();
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

  /** Records a new part on `stream`; resolves once the store has the part. */
  private async beginPart(stream: MediaStream): Promise<void> {
    const store = this.store!;
    const { id, mimeType } = this.snapshot.recording!;
    let recorder: MediaRecorder;
    try {
      recorder = this.deps.createRecorder(stream, {
        mimeType,
        audioBitsPerSecond: SPEECH_RECORDING.audioBitsPerSecond,
      });
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      throw error;
    }
    // Recording starts at once; the store queues the part before any of its chunks.
    const part = store.startPart(id);

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
      const durationMs = this.partElapsed();
      void part
        .then((index) => store.append(id, index, data, durationMs))
        .then(() => {
          if (store.persistent !== this.snapshot.persistent) this.set({ persistent: store.persistent });
        });
      if (chunks % SPACE_CHECK_EVERY_CHUNKS === 0) {
        void store.lowOnSpace().then((lowSpace) => lowSpace !== this.snapshot.lowSpace && this.set({ lowSpace }));
      }
      this.set({ partBytes, recordedBytes: this.earlierPartsBytes + partBytes });
      // Before the next chunk could make the file too large to send.
      const { maxBytes } = this.limits;
      if (maxBytes && partBytes + 2 * data.size > maxBytes) this.partFull(maxBytes);
    };

    const onStop = async () => {
      // A stop nobody asked for means the microphone went away.
      const reason = this.ending ?? "interrupt";
      tracks.forEach((track) => {
        track.removeEventListener("ended", lose);
        track.removeEventListener("mute", lose);
        // A new part goes on with the same microphone.
        if (reason !== "rotate") track.stop();
      });
      recorder.removeEventListener("dataavailable", onData);
      recorder.removeEventListener("error", lose);
      recorder.removeEventListener("stop", onStop);
      this.earlierPartsMs += this.partElapsed();
      this.earlierPartsBytes += partBytes;
      this.partMs = 0;
      this.runningSince = null;
      this.recorder = null;
      if (reason === "rotate") {
        ended();
        await this.beginPart(stream).catch(() => this.pause());
        return;
      }
      if (reason === "interrupt") await this.pause();
      else this.releaseWakeLock();
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
    this.partCount = (await part) + 1;
  }

  /** The part holds what the flow takes per file: go on in a new part while the flow takes more files. */
  private partFull(maxBytes: number) {
    const { maxFiles } = this.limits;
    if (maxFiles === undefined || this.partCount < maxFiles) {
      void this.endPart("rotate");
      return;
    }
    const limit = maxFiles === 1 ? formatBytes(maxBytes) : `${maxFiles} filer om ${formatBytes(maxBytes)}`;
    this.set({ error: `Inspelningen stoppades vid flödets gräns på ${limit}. Det som spelats in är sparat.` });
    void this.stop();
  }

  /** The microphone went away: keep what was recorded, paused, for "Fortsätt spela in". */
  private async pause() {
    const { id } = this.snapshot.recording!;
    const store = this.store!;
    this.releaseWakeLock();
    await store.setState(id, "paused");
    this.set({ status: "interrupted", stream: null, recording: await store.get(id) });
  }

  /** True, with the microphone let go, when the page went away during a start. */
  private left(generation: number, stream: MediaStream): boolean {
    if (generation === this.generation) return false;
    stream.getTracks().forEach((track) => track.stop());
    return true;
  }

  private endPart(reason: EndReason): Promise<void> {
    // A stop, a leave or a lost microphone wins over starting a new part.
    if (!this.ending || this.ending === "rotate") this.ending = reason;
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
