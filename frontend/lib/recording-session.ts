/**
 * Captures audio into the recording store, one part (one audio file) per
 * MediaRecorder run. Losing the microphone pauses the recording: its track
 * ends or is muted (a phone call, a phone putting the page in the background)
 * or the recorder stops or fails by itself. `continueRecording()` then starts
 * a new part of the same recording on a fresh microphone stream; `adopt()`
 * does the same for a recording that a reload cut off, and `continueStopped()`
 * for one the user stopped too early. A part nearing the
 * flow's per-file limit, in bytes or in time, hands over to a new part on the
 * same stream, the two overlapping briefly, until the flow's file count is
 * used up. A hidden page,
 * or a closing tab, flushes the current chunk, so a page the system kills
 * loses as little as possible; hiding alone does not pause, since a laptop
 * keeps recording in a background tab.
 */

import { formatBytes, formatDuration } from "./format";
import {
  continuable,
  IN_USE_ELSEWHERE,
  NOT_ON_DEVICE,
  sealed,
  type DeviceRefusal,
  type NewRecording,
  type RecordingStore,
  type StoredRecording,
} from "./recording-store";

export const CHUNK_MS = 2_000;

/**
 * Speech, not music: one channel at 32 kbit/s, Opus where the browser records
 * it and its own format otherwise (Safari: audio/mp4, see the recorder's
 * format choice). A 5-hour meeting is then about 72 MB (32 kbit/s for
 * 18,000 s), well under a flow's per-file limit, and speech stays clearly
 * intelligible.
 */
export const SPEECH_RECORDING = { channelCount: 1, audioBitsPerSecond: 32_000 } as const;

/**
 * Chromium's MediaRecorder drops the last 9-71 ms before stop(), so a full
 * part records on this long after the next part has started: the files
 * overlap instead of leaving a gap (Eneo's recorder measured 103-143 ms of
 * overlap and no gap). A hidden tab may stretch the wait to about a second,
 * which a part's headroom has room for.
 */
export const ROTATION_OVERLAP_MS = 150;

/**
 * Room a part keeps below Eneo's time per file: the overlap with the next part, a timer a hidden tab fires late
 * (about a second) and the page's clock against the decoded audio. A minute, or 5 % of a limit under 20 minutes,
 * and never under two seconds.
 */
const durationHeadroom = (limitMs: number) => Math.max(limitMs < 20 * 60_000 ? limitMs * 0.05 : 60_000, 2_000);

// The recording's target rate, in bytes per millisecond.
const TARGET_BYTES_PER_MS = SPEECH_RECORDING.audioBitsPerSecond / 8 / 1000;
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
  /** The device stopped keeping this recording partway (full, or a refused write): the rest is in this tab only. */
  refused: DeviceRefusal | null;
  /** Recording time left before the flow's last allowed file is full; null when the flow sets no such limit. */
  remainingMs: number | null;
  /** The recording stopped because the flow takes no more files. */
  limitReached: boolean;
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
  /** The window: a closing tab says so there with pagehide, in older Safari without a visibilitychange. */
  window?: Pick<Window, "addEventListener" | "removeEventListener">;
  now?(): number;
}

/** The flow's limits for the audio step: bytes and recorded time per file, and files per run. */
export interface CaptureLimits {
  maxBytes?: number;
  maxDurationMs?: number;
  maxFiles?: number;
}

type EndReason = "stop" | "interrupt" | "leave";

const NOT_CONTINUABLE = "Inspelningen är avslutad och kan inte fortsätta.";
const SEND_BEGUN = "Inspelningen skickas eller har redan skickats och kan inte fortsätta.";

// A recording's files: its parts with audio.
const filesIn = (recording: StoredRecording) => recording.parts.filter((part) => part.bytes > 0).length;

const noMoreFiles = (maxFiles: number) =>
  `Flödet tar emot högst ${maxFiles} ${maxFiles === 1 ? "fil" : "filer"}, och inspelningen har redan så många delar.`;

/** A refusal whose sentence the user reads as it is. */
class Refusal extends Error {}

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

/** One MediaRecorder run and the file it makes. */
interface Part {
  recorder: MediaRecorder;
  /** Its index in the store; its chunks wait for it. */
  index: Promise<number>;
  bytes: number;
  /** Recorded time before its latest pause, and since when it runs again. */
  ms: number;
  since: number | null;
  ending: EndReason | null;
  ended: Promise<void>;
  /** Its recorded time has joined that of the earlier parts. */
  counted: boolean;
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
    refused: null,
    remainingMs: null,
    limitReached: false,
  };
  private listeners = new Set<() => void>();
  private store: RecordingStore | null = null;
  private microphone: MediaStream | null = null;
  // The part recording now, and a full part still recording its overlap.
  private part: Part | null = null;
  private overlapping: { part: Part; timer: ReturnType<typeof setTimeout> } | null = null;
  // The running part's handover at Eneo's time per file.
  private handover: ReturnType<typeof setTimeout> | null = null;
  private release: (() => void) | null = null;
  private wakeLock: WakeLockLike | null = null;
  private starting = false;
  // Bumped by Stoppa and when the page goes away: a start begun before must not record.
  private generation = 0;
  private limits: CaptureLimits = {};
  // Files the recording has, the running part included.
  private partCount = 0;
  // The largest chunk so far: the encoder's real rate when above its target.
  private largestChunk = 0;
  private chunks = 0;
  // Recorded time of the parts before the running one, on a monotonic clock:
  // never by counting timer ticks, which hidden tabs throttle.
  private earlierPartsMs = 0;

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
    const part = this.part;
    return this.earlierPartsMs + (part && !part.counted ? this.partElapsed(part) : 0);
  }

  async start(init: NewRecording, limits: CaptureLimits = {}): Promise<void> {
    const { status } = this.snapshot;
    if (this.starting || (status !== "idle" && status !== "stopped")) return;
    this.starting = true;
    this.set({ error: null, limitReached: false });
    const generation = this.generation;
    let created: StoredRecording | null = null;
    try {
      const stream = await this.openMicrophone();
      if (this.left(generation)) return;
      const store = (this.store ??= await this.openStore());
      const recording = (created = await store.create(init));
      this.release = () => store.release(recording.id);
      void store.requestPersistence();
      const lowSpace = await store.lowOnSpace();
      if (this.left(generation)) {
        // Nothing was recorded: do not leave an empty recording to recover.
        await store.discard(recording.id).catch(() => undefined);
        this.finish();
        return;
      }
      this.prepare(limits, 0, 0);
      this.set({ recording, recordedBytes: 0, lowSpace, persistent: store.persistent, refused: null });
      this.record(stream);
      await this.takeWakeLock();
      if (generation !== this.generation) this.dispose();
    } catch (error) {
      // Nothing was recorded: do not leave an empty recording to recover.
      if (created) await this.store?.discard(created.id).catch(() => undefined);
      this.finish();
      this.set({ status: "idle", recording: null, error: microphoneError(error) });
    } finally {
      this.starting = false;
    }
  }

  /**
   * Takes over a recording whose capture ended without a stop (the tab was
   * reloaded or killed) and records on in a new part of it, like a new
   * recording, so the meeting still becomes one run.
   */
  adopt(recordingId: string, limits: CaptureLimits = {}): Promise<void> {
    return this.takeOver(recordingId, limits, (found) => (continuable(found) ? null : NOT_CONTINUABLE));
  }

  /**
   * "Fortsätt spela in" on a recording the user stopped too early: records on
   * in a new part of it, as `adopt()` does, until a send of it has begun.
   */
  continueStopped(recordingId: string, limits: CaptureLimits = {}): Promise<void> {
    return this.takeOver(recordingId, limits, (found) => (sealed(found) ? SEND_BEGUN : null));
  }

  /** "Fortsätt spela in" after an interruption: a new part of the same recording. */
  async continueRecording(): Promise<void> {
    if (this.starting || this.snapshot.status !== "interrupted") return;
    const { maxFiles } = this.limits;
    if (maxFiles !== undefined && this.partCount >= maxFiles) {
      this.set({ error: noMoreFiles(maxFiles) });
      return;
    }
    this.starting = true;
    this.set({ error: null });
    const generation = this.generation;
    try {
      const stream = await this.openMicrophone();
      if (this.left(generation)) return;
      this.record(stream);
      await this.takeWakeLock();
    } catch (error) {
      this.stopMicrophone();
      this.set({ error: microphoneError(error) });
    } finally {
      this.starting = false;
    }
  }

  togglePause(): void {
    const part = this.part;
    if (part?.recorder.state === "recording") {
      part.recorder.pause();
      part.ms = this.partElapsed(part);
      part.since = null;
      this.set({ status: "paused" });
    } else if (part?.recorder.state === "paused") {
      part.recorder.resume();
      part.since = this.now();
      this.scheduleHandover(part);
      this.set({ status: "recording" });
    }
  }

  async stop(): Promise<StoredRecording | null> {
    this.generation += 1;
    const { recording, status } = this.snapshot;
    const store = this.store;
    if (!recording || !store || status === "idle" || status === "stopped") return null;
    await this.endParts("stop");
    await store.setState(recording.id, "stopped");
    const stopped = await store.get(recording.id);
    this.finish();
    this.set({ status: "stopped", recording: stopped, stream: null });
    return stopped;
  }

  /** "Spela in på nytt": the stored recording stays until it is sent or deleted. */
  reset(): void {
    if (this.snapshot.status === "stopped") {
      this.set({ status: "idle", recording: null, partBytes: 0, error: null, remainingMs: null, limitReached: false });
    }
  }

  /** The page goes away: what was recorded stays, paused, for recovery. */
  dispose(): void {
    this.generation += 1;
    const { recording, status } = this.snapshot;
    const store = this.store;
    if (!recording || !store || status === "idle" || status === "stopped") return;
    void this.endParts("leave")
      .then(() => store.setState(recording.id, "paused"))
      .finally(() => this.finish());
  }

  /**
   * Leases a stored recording and records on in a new part of it, unless
   * `refusal` names a reason; a refusal leaves the capture as it was.
   */
  private async takeOver(
    recordingId: string,
    limits: CaptureLimits,
    refusal: (found: StoredRecording) => string | null,
  ): Promise<void> {
    const before = this.snapshot;
    if (this.starting || (before.status !== "idle" && before.status !== "stopped")) return;
    this.starting = true;
    this.set({ error: null, limitReached: false });
    const generation = this.generation;
    try {
      const store = (this.store ??= await this.openStore());
      // Read before the lease, so a send in progress gives its own reason, and
      // again under it, where no other tab changes the recording any more.
      const eligible = async () => {
        const found = await store.get(recordingId);
        if (!found) throw new Refusal(NOT_ON_DEVICE);
        const reason = refusal(found);
        if (reason) throw new Refusal(reason);
        if (limits.maxFiles !== undefined && filesIn(found) >= limits.maxFiles) {
          throw new Refusal(noMoreFiles(limits.maxFiles));
        }
        return found;
      };
      await eligible();
      if (!(await store.lease(recordingId))) throw new Refusal(IN_USE_ELSEWHERE);
      this.release = () => store.release(recordingId);
      const found = await eligible();
      const stream = await this.openMicrophone().catch((error) => {
        throw new Refusal(microphoneError(error));
      });
      const lowSpace = await store.lowOnSpace();
      if (this.left(generation)) {
        this.finish();
        return;
      }
      this.prepare(limits, filesIn(found), found.durationMs);
      this.set({
        recording: found,
        recordedBytes: found.parts.reduce((sum, part) => sum + part.bytes, 0),
        lowSpace,
        persistent: store.persistent,
        refused: store.refused(found.id),
      });
      this.record(stream);
      await this.takeWakeLock();
      if (generation !== this.generation) this.dispose();
    } catch (error) {
      this.finish();
      const message = error instanceof Refusal ? error.message : "Inspelningen kunde inte öppnas.";
      this.set({ ...before, error: message });
    } finally {
      this.starting = false;
    }
  }

  private prepare(limits: CaptureLimits, files: number, earlierMs: number) {
    this.limits = limits;
    this.partCount = files;
    this.largestChunk = 0;
    this.chunks = 0;
    this.earlierPartsMs = earlierMs;
    this.part = null;
  }

  /** Records a part on the opened microphone, listening for it to go away. */
  private record(stream: MediaStream) {
    stream.getAudioTracks().forEach((track) => {
      track.addEventListener("ended", this.onMicrophoneLost);
      track.addEventListener("mute", this.onMicrophoneLost);
    });
    this.deps.page?.addEventListener("visibilitychange", this.onVisibilityChange);
    this.deps.window?.addEventListener("pagehide", this.flush);
    this.beginPart(stream);
  }

  /** Records a new part on `stream`; throws when the browser will not start a recorder. */
  private beginPart(stream: MediaStream): Part {
    const store = this.store!;
    const { id, mimeType } = this.snapshot.recording!;
    const recorder = this.deps.createRecorder(stream, {
      mimeType,
      audioBitsPerSecond: SPEECH_RECORDING.audioBitsPerSecond,
    });
    let ended = () => {};
    const part: Part = {
      recorder,
      // Queued before any of the part's chunks.
      index: store.startPart(id),
      bytes: 0,
      ms: 0,
      since: null,
      ending: null,
      ended: new Promise<void>((resolve) => (ended = resolve)),
      counted: false,
    };

    const onData = (event: Event) => {
      const data = (event as BlobEvent).data;
      if (!data || data.size === 0) return;
      part.bytes += data.size;
      const durationMs = this.partElapsed(part);
      void part.index
        .then((index) => store.append(id, index, data, durationMs))
        .then(() => {
          const refused = store.refused(id);
          if (store.persistent !== this.snapshot.persistent || refused !== this.snapshot.refused) {
            this.set({ persistent: store.persistent, refused });
          }
        })
        .catch(() => undefined);
      this.chunks += 1;
      if (this.chunks % SPACE_CHECK_EVERY_CHUNKS === 0) {
        void store.lowOnSpace().then((lowSpace) => lowSpace !== this.snapshot.lowSpace && this.set({ lowSpace }));
      }
      this.set({ recordedBytes: this.snapshot.recordedBytes + data.size });
      // A full part's overlap belongs to its own file, not to the running one.
      if (part !== this.part) return;
      this.largestChunk = Math.max(this.largestChunk, data.size);
      this.set({ partBytes: part.bytes, remainingMs: this.remaining(part) });
      if (!part.ending) this.checkLimit(part);
    };

    const onError = () => void this.endPart(part, "interrupt");

    const onStop = async () => {
      recorder.removeEventListener("dataavailable", onData);
      recorder.removeEventListener("error", onError);
      recorder.removeEventListener("stop", onStop);
      this.countTime(part);
      part.since = null;
      // A full part ending its overlap has handed over; only the running part's end counts.
      if (this.part === part) {
        this.part = null;
        this.clearHandover();
        // A stop nobody asked for means the microphone went away.
        if ((part.ending ?? "interrupt") === "interrupt") await this.pause();
      }
      ended();
    };

    recorder.addEventListener("dataavailable", onData);
    recorder.addEventListener("error", onError);
    recorder.addEventListener("stop", onStop);
    recorder.start(CHUNK_MS);
    part.since = this.now();
    this.part = part;
    this.scheduleHandover(part);
    this.partCount += 1;
    this.set({ status: "recording", stream, partBytes: 0, remainingMs: this.remaining(part) });
    return part;
  }

  /** Before the part could grow too large or too long to send: a new part, or a stop once the flow takes no more files. */
  private checkLimit(part: Part) {
    const { maxBytes, maxDurationMs, maxFiles } = this.limits;
    const full = !!maxBytes && part.bytes + this.headroom() > maxBytes;
    const long = !!maxDurationMs && this.partElapsed(part) + durationHeadroom(maxDurationMs) >= maxDurationMs;
    if (!full && !long) return;
    if (maxFiles === undefined || this.partCount < maxFiles) {
      this.rotate(part);
      return;
    }
    let error: string;
    if (full) {
      const limit = maxFiles === 1 ? formatBytes(maxBytes!) : `${maxFiles} filer om ${formatBytes(maxBytes!)}`;
      error = `Inspelningen stoppades vid flödets gräns på ${limit}. Det som spelats in är sparat.`;
    } else {
      error =
        `Inspelningen nådde maxlängden ${formatDuration(maxFiles * maxDurationMs!)} och stoppades efter ` +
        `${formatDuration(this.elapsedMs())}. Den är sparad. Skicka den, eller starta en ny inspelning för resten av mötet.`;
    }
    this.set({ limitReached: true, remainingMs: 0, error });
    void this.stop();
  }

  /**
   * The time handover runs on its own timer on the recorded clock (pauses stop it), not on chunk delivery, which a
   * locked phone may hold back. Its bound: a page the browser suspends past the deadline, so that even this timer
   * fires late, can still overrun a part. That recording stays on the device, and the send refuses it and says so
   * (submit-run's sendLeased), with Spara som fil as the way to keep it.
   */
  private scheduleHandover(part: Part) {
    this.clearHandover();
    const { maxDurationMs } = this.limits;
    if (!maxDurationMs || part.since === null) return;
    const due = maxDurationMs - durationHeadroom(maxDurationMs) - this.partElapsed(part);
    // Whole milliseconds, rounded up: a browser cuts a fraction off, which would fire short of the deadline.
    this.handover = setTimeout(() => {
      this.handover = null;
      // A part that is ending (Stoppa, a page leave) hands over to nothing.
      if (part !== this.part || part.ending) return;
      this.checkLimit(part);
      // Short of the deadline still (a timer that fired early): again for the rest. A pause sets it anew on going on.
      if (part === this.part && !part.ending && part.since !== null) this.scheduleHandover(part);
    }, Math.max(0, Math.ceil(due)));
  }

  private clearHandover() {
    if (this.handover !== null) clearTimeout(this.handover);
    this.handover = null;
  }

  /** A new part takes over on the same microphone; the full one stops once the two overlap. */
  private rotate(full: Part) {
    try {
      this.beginPart(this.microphone!);
    } catch {
      // The browser will not start another recorder: keep what there is, paused.
      void this.endPart(full, "interrupt");
      return;
    }
    this.countTime(full);
    void this.endOverlap();
    this.overlapping = {
      part: full,
      timer: setTimeout(() => void this.endOverlap(), ROTATION_OVERLAP_MS),
    };
  }

  /**
   * Room a part keeps below the per-file limit, as time at the recording's
   * rate: the chunk still to come before the next check, the overlap with the
   * next part, and one chunk more, since a variable-rate encoder can exceed its
   * target. The rate is the target or the largest chunk so far, whichever is higher.
   */
  private headroom(): number {
    return this.rate() * (2 * CHUNK_MS + ROTATION_OVERLAP_MS);
  }

  private rate(): number {
    return Math.max(TARGET_BYTES_PER_MS, this.largestChunk / CHUNK_MS);
  }

  /** Recording time left before the flow's last allowed file is full or long enough; null without a file count. */
  private remaining(part: Part | null): number | null {
    const { maxBytes, maxDurationMs, maxFiles } = this.limits;
    if (maxFiles === undefined || (!maxBytes && !maxDurationMs)) return null;
    // The time a part holds from here: until the first of its limits.
    const holds = (bytes: number, ms: number) =>
      Math.min(
        maxBytes ? Math.max(0, maxBytes - this.headroom() - bytes) / this.rate() : Infinity,
        maxDurationMs ? Math.max(0, maxDurationMs - durationHeadroom(maxDurationMs) - ms) : Infinity,
      );
    const running = part ? holds(part.bytes, this.partElapsed(part)) : 0;
    const later = Math.max(0, maxFiles - this.partCount) * holds(0, 0);
    return Math.floor(running + later);
  }

  /** Ends the running parts, a full part still overlapping first; resolves once both have stopped. */
  private endParts(reason: EndReason): Promise<void> {
    const ended = [this.endOverlap()];
    if (this.part) ended.push(this.endPart(this.part, reason));
    return Promise.all(ended).then(() => undefined);
  }

  /** Ends a full part's overlap now. */
  private endOverlap(): Promise<void> {
    const overlap = this.overlapping;
    this.overlapping = null;
    if (!overlap) return Promise.resolve();
    clearTimeout(overlap.timer);
    return this.endPart(overlap.part, "stop");
  }

  private endPart(part: Part, reason: EndReason): Promise<void> {
    part.ending ??= reason;
    // Its deadline goes as its end begins, not at the stop event after it.
    if (part === this.part) this.clearHandover();
    try {
      if (part.recorder.state !== "inactive") part.recorder.stop();
    } catch {
      // Already stopping.
    }
    return part.ended;
  }

  /** The microphone went away: keep what was recorded, paused, for "Fortsätt spela in". */
  private async pause() {
    await this.endOverlap();
    this.stopMicrophone();
    this.releaseWakeLock();
    const { id } = this.snapshot.recording!;
    const store = this.store!;
    await store.setState(id, "paused");
    const recording = await store.get(id);
    this.partCount = recording ? filesIn(recording) : this.partCount;
    this.set({
      status: "interrupted",
      stream: null,
      partBytes: 0,
      recording,
      remainingMs: this.remaining(null),
    });
  }

  private onMicrophoneLost = () => void this.endParts("interrupt");

  /** True, with the microphone let go, when the page went away during a start. */
  private left(generation: number): boolean {
    if (generation === this.generation) return false;
    this.stopMicrophone();
    return true;
  }

  /** The capture owns the stream from here: every way out stops it. */
  private async openMicrophone(): Promise<MediaStream> {
    const stream = await this.deps.getStream({
      audio: { channelCount: SPEECH_RECORDING.channelCount },
    });
    this.microphone = stream;
    return stream;
  }

  private stopMicrophone() {
    const stream = this.microphone;
    this.microphone = null;
    stream?.getAudioTracks().forEach((track) => {
      track.removeEventListener("ended", this.onMicrophoneLost);
      track.removeEventListener("mute", this.onMicrophoneLost);
    });
    stream?.getTracks().forEach((track) => track.stop());
  }

  /** A phone may freeze or kill a hidden page, and a tab may close: store what is recorded so far. */
  private flush = () => {
    try {
      this.part?.recorder.requestData();
    } catch {
      // Nothing to flush.
    }
  };

  private onVisibilityChange = () => {
    const { status } = this.snapshot;
    if (status !== "recording" && status !== "paused") return;
    if (this.deps.page?.visibilityState === "hidden") return this.flush();
    // The wake lock ended with the hidden page; the microphone may have too.
    void this.takeWakeLock();
    const lost =
      this.part?.recorder.state === "inactive" ||
      this.microphone?.getAudioTracks().some((track) => track.readyState === "ended" || track.muted);
    if (lost) this.onMicrophoneLost();
  };

  private async takeWakeLock() {
    this.releaseWakeLock();
    try {
      const lock = (await this.deps.requestWakeLock?.()) ?? null;
      if (this.part) this.wakeLock = lock;
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

  private countTime(part: Part) {
    if (part.counted) return;
    this.earlierPartsMs += this.partElapsed(part);
    part.counted = true;
  }

  private partElapsed(part: Part): number {
    return part.ms + (part.since == null ? 0 : this.now() - part.since);
  }

  private now(): number {
    return this.deps.now?.() ?? performance.now();
  }

  private finish() {
    this.deps.page?.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.deps.window?.removeEventListener("pagehide", this.flush);
    this.stopMicrophone();
    this.release?.();
    this.release = null;
    this.releaseWakeLock();
  }

  private set(patch: Partial<CaptureSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}
