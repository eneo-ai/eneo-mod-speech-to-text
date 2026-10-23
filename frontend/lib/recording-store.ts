/**
 * The one owner of recordings on the device. Every MediaRecorder chunk is
 * stored in IndexedDB as it arrives, under the recording id, part and
 * sequence number; a part is a valid audio file when its chunks are joined in
 * order. A crash, reload, power cut or expired session therefore loses at most
 * the latest chunk. Without IndexedDB, or when the device refuses a write, the
 * audio is kept in memory and `persistent` turns false: the recording then
 * lives only in this tab. A device that refused (full, or failing) is tried
 * again until it takes what this tab holds, and the recording is kept on it again.
 */

import type { Json, UploadHandle } from "./api";
import { baseMimetype, extensionForAudioMime } from "./upload";
import { withRecordedDuration } from "./webm-duration";
import { keyframeMarker } from "./webm-keyframes";

type RecordingState =
  | "recording"
  | "paused"
  | "stopped"
  | "uploading"
  | "uploaded"
  | "submitted";

type RecordingInputMode = "record" | "stream";
export type DeviceRefusal = "full" | "failed" | "lost";

interface RecordingPart {
  index: number;
  startedAt: number;
  durationMs: number;
  bytes: number;
  chunks: number;
  /** False while the recorder may still deliver final audio. Absent on recordings made before this field existed. */
  endConfirmed?: boolean;
  /** Eneo's file id once this part is uploaded. */
  fileId: string | null;
  /** The module's resource for this part's upload in parts, until the file id is known: a later send continues it. */
  upload?: UploadHandle | null;
}

export interface StoredRecording {
  id: string;
  /** The signed-in user who made it; a shared device offers it to no one else. */
  ownerId: string;
  flowId: string;
  flowName: string;
  stepId: string;
  inputMode: RecordingInputMode;
  mimeType: string;
  startedAt: number;
  durationMs: number;
  state: RecordingState;
  parts: RecordingPart[];
  runId: string | null;
  /**
   * The run request as Eneo was asked for it, kept until Eneo answers: a send
   * that never heard back repeats exactly this, and Eneo returns the run it made.
   */
  submission?: RunRequest | null;
  /**
   * Eneo's stored text of the live session (Strömma) that heard the whole recording, while it is one part: the
   * run uses it instead of transcribing the audio again. A new part forgets it.
   */
  liveTranscriptId?: string | null;
}

export interface RunRequest {
  body: Json;
  idempotencyKey: string;
}

export type NewRecording = Pick<
  StoredRecording,
  "ownerId" | "flowId" | "flowName" | "stepId" | "inputMode" | "mimeType"
> & {
  /** Chosen ahead when live text names the recording before it exists; a new one otherwise. */
  id?: string;
};

/** One part as an audio file, ready to upload or save. */
export interface RecordingFile {
  index: number;
  blob: Blob;
  filename: string;
}

export interface StoreEnv {
  indexedDB?: IDBFactory;
  keyRange?: typeof IDBKeyRange;
  storage?: Pick<StorageManager, "estimate" | "persist"> & Partial<Pick<StorageManager, "persisted">>;
  locks?: Pick<LockManager, "request" | "query">;
  now?: () => number;
  /** Runs `run` after `ms`: how a device that refused is tried again. Without it only an estimate that shows room tries it. */
  timer?: (run: () => void, ms: number) => void;
}

const DB_NAME = "tal-till-text";
const DB_VERSION = 1;
const RECORDINGS = "recordings";
const CHUNKS = "chunks";
// 100 MiB: about 7 hours of speech at the recorder's 32 kbit/s (about 4 at the 54 kbit/s WebKit gives); below this the recorder warns.
const LOW_SPACE_BYTES = 100 * 1024 * 1024;
// How often a device that refused audio (full, or failing) is tried again.
const RETRY_MS = 20_000;
// How many of a part's chunks are read from the device at a time: about 2 MB of a recorder's 2-second chunks.
const READ_BATCH = 256;

interface Chunk {
  recordingId: string;
  part: number;
  seq: number;
  data: Blob | ArrayBuffer;
}

interface Backend {
  /** The recording and its new chunks, all of them or none. */
  put(recording: StoredRecording, chunks?: Chunk[]): Promise<void>;
  get(id: string): Promise<StoredRecording | undefined>;
  list(): Promise<StoredRecording[]>;
  /** The part's chunks in order, from sequence number `from` on, at most `count` of them. */
  chunks(id: string, part: number, from?: number, count?: number): Promise<Chunk[]>;
  delete(id: string): Promise<void>;
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function completion(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(RECORDINGS, { keyPath: "id" });
      request.result.createObjectStore(CHUNKS, {
        keyPath: ["recordingId", "part", "seq"],
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** The device has no room: a new connection gives it none. */
function quotaExceeded(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "QuotaExceededError";
}

/**
 * The database, over a connection that is reopened when a call on it fails for any reason but a full device: the browser
 * may have closed it (to free memory or clean a profile) or lost it (WebKit's "Connection to Indexed Database server
 * lost"). A failed call reopens it once (one reopening for every call that fails on the same connection) and tries again;
 * every call here can be repeated, and a reopening that fails is the call's own failure, never an empty answer.
 */
function idbBackend(initial: IDBDatabase, keyRange: typeof IDBKeyRange, reopen: () => Promise<IDBDatabase>): Backend {
  let db = initial;
  let reopening: Promise<IDBDatabase> | null = null;
  async function use<T>(work: (db: IDBDatabase) => Promise<T>): Promise<T> {
    const used = db;
    try {
      return await work(used);
    } catch (error) {
      if (quotaExceeded(error)) throw error;
      if (db === used) {
        reopening ??= reopen().finally(() => {
          reopening = null;
        });
        db = await reopening;
        // It may still be open: what runs on it finishes, and nothing new starts there.
        used.close();
      }
      return work(db);
    }
  }
  return {
    async put(recording, chunks = []) {
      // Safari cannot always store a Blob in IndexedDB; an ArrayBuffer works everywhere.
      const stored = await Promise.all(
        chunks.map(async (chunk) => ({ ...chunk, data: chunk.data instanceof Blob ? await chunk.data.arrayBuffer() : chunk.data })),
      );
      await use(async (db) => {
        // Strict: on the disk before the write counts as done, so a power cut loses at most the chunk being written. A
        // browser without the option ignores it and keeps its own default.
        const tx = db.transaction([RECORDINGS, CHUNKS], "readwrite", { durability: "strict" });
        const done = completion(tx);
        try {
          tx.objectStore(RECORDINGS).put(recording);
          for (const chunk of stored) tx.objectStore(CHUNKS).put(chunk);
        } catch (error) {
          done.catch(() => undefined);
          tx.abort();
          throw error;
        }
        await done;
      });
    },
    get: (id) => use(async (db) => result(db.transaction(RECORDINGS).objectStore(RECORDINGS).get(id))),
    list: () => use(async (db) => result(db.transaction(RECORDINGS).objectStore(RECORDINGS).getAll())),
    chunks: (id, part, from = 0, count) =>
      use(async (db) =>
        result(
          db
            .transaction(CHUNKS)
            .objectStore(CHUNKS)
            .getAll(keyRange.bound([id, part, from], [id, part, Infinity]), count),
        ),
      ),
    delete: (id) =>
      use(async (db) => {
        const tx = db.transaction([RECORDINGS, CHUNKS], "readwrite");
        tx.objectStore(CHUNKS).delete(keyRange.bound([id, 0, 0], [id, Infinity, Infinity]));
        tx.objectStore(RECORDINGS).delete(id);
        await completion(tx);
      }),
  };
}

export function memoryBackend(): Backend {
  const recordings = new Map<string, StoredRecording>();
  const chunks = new Map<string, Chunk[]>();
  return {
    async put(recording, added = []) {
      recordings.set(recording.id, recording);
      if (added.length === 0) return;
      // In place: the array is this backend's own (chunks() hands out copies), and a copy per chunk is quadratic over
      // a recording of thousands of chunks.
      const held = chunks.get(recording.id);
      if (held) added.forEach((chunk) => held.push(chunk));
      else chunks.set(recording.id, added.slice());
    },
    get: async (id) => recordings.get(id),
    list: async () => [...recordings.values()],
    chunks: async (id, part, from = 0, count) =>
      (chunks.get(id) ?? [])
        .filter((c) => c.part === part && c.seq >= from)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, count),
    async delete(id) {
      recordings.delete(id);
      chunks.delete(id);
    },
  };
}

const lockName = (id: string) => `tal-till-text-recording:${id}`;

export const IN_USE_ELSEWHERE = "Inspelningen används i en annan flik.";
export const NOT_ON_DEVICE = "Inspelningen finns inte längre på enheten.";
/** Chunks of the recording are gone from the device (it cleared its storage, or lost the database): it would go shorter. */
export const INCOMPLETE_ON_DEVICE =
  "Inspelningen är ofullständig på enheten: en del av ljudet saknas, så den skickas inte. Spara den som fil för att behålla det som finns kvar.";
/** Eneo has a run under the recording's key: sent, from this send or an earlier one. */
export const ALREADY_SENT = "Inspelningen har redan skickats. Körningen finns under Tidigare körningar.";

/**
 * Sealed from its first send on: the audio sent is the audio kept, so no part
 * is added and no send's end makes it "stopped" again. A send marks it
 * uploading, then uploaded while Eneo is asked for the run, then submitted.
 */
export function sealed(recording: StoredRecording): boolean {
  return recording.state === "uploading" || recording.state === "uploaded" || recording.state === "submitted";
}

/** Its capture ended without a stop (a reload, a killed tab). */
export function cutOff(recording: StoredRecording): boolean {
  return recording.state === "recording" || recording.state === "paused";
}

/**
 * "Fortsätt spela in" adds a part: to a capture that was cut off, and to one the person stopped, also after leaving the
 * page it was stopped on, until a send of it has begun (it is then sealed).
 */
export function continuable(recording: StoredRecording): boolean {
  return cutOff(recording) || recording.state === "stopped";
}

/** A recording's files: its parts with audio. */
export const filesIn = (recording: StoredRecording) => recording.parts.filter((part) => part.bytes > 0).length;

/** Whether any audio reached the device: a recording without is nothing to send or save, only to go on with or delete. */
export const hasAudio = (recording: StoredRecording) => filesIn(recording) > 0;

/** `inspelning-2026-09-23-1012.webm`, with `-del-2` when there are several parts. */
function recordingFilename(recording: StoredRecording, index: number): string {
  const d = new Date(recording.startedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const part = recording.parts.length > 1 ? `-del-${index + 1}` : "";
  return `inspelning-${stamp}${part}.${extensionForAudioMime(recording.mimeType)}`;
}

/**
 * Leases. A tab writes a recording only while it holds the recording's lease:
 * the tab that records it (a new recording is born leased), and a tab that
 * sends or deletes it. The lease is a Web Lock, not a heartbeat: the browser
 * ends it the moment the tab closes, reloads or crashes, with no timeout to
 * tune, and it cannot look expired while a background tab records (hidden
 * tabs throttle timers to once a minute) or while the user has paused.
 * Without Web Locks (Safari before 15.4) nothing keeps two tabs apart: only
 * the tab that made a recording changes it, and any other tab, or the same one
 * after a reload, can only save it as a file.
 */
export class RecordingStore {
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  // Leases this tab holds (with how to end each), and this tab's latest copy
  // of those recordings. The database stays the truth, since without Web
  // Locks another tab may have changed or deleted a recording: the copy
  // serves only when the device cannot read.
  private leases = new Map<string, () => void>();
  // The leases an operation here (a capture, a send, a delete) is using. A
  // lease no operation uses is kept for audio only this tab has.
  private inUse = new Set<string>();
  // The recordings this tab made: without Web Locks, the only ones it may change.
  private made = new Set<string>();
  private live = new Map<string, StoredRecording>();
  // Stopped recordings this page still shows: their lease stays with this tab between its operations, so no other tab
  // offers or deletes one that is on this tab's screen (`hold`, until `letGo`).
  private held = new Set<string>();
  // Recorders that can still deliver final audio, including after the page stopped waiting or left the view.
  private writers = new Map<string, number>();
  // What the device refused to store stays here, in this tab.
  private overflow = memoryBackend();
  // Recordings the device stopped keeping, and why: its storage is full, it refused the write, or its copy is gone.
  private overflowed = new Map<string, DeviceRefusal>();
  // A try of the device that refused is waiting on the timer.
  private retrying = false;
  // The first chunk of the part being recorded, which holds its header: all that is left to play of a part
  // when the device's copy goes (the browser's data is cleared), together with what is recorded after it.
  private heads = new Map<string, { part: number; data: Blob }>();
  // What the browser says of keeping this device's storage: true when it will not delete it; null until it has said.
  private kept: boolean | null = null;
  private askedToKeep = false;

  constructor(
    private backend: Backend,
    private durable: boolean,
    private env: StoreEnv,
  ) {}

  /** False when the audio (or part of it) lives only in this tab. */
  get persistent(): boolean {
    return this.durable && this.overflowed.size === 0;
  }

  /**
   * True when the browser says it may delete this device's recordings (its storage is not persistent): Safari clears
   * a site's storage after a week without a visit, and any browser may under pressure. False while it has not said.
   */
  get evictable(): boolean {
    return this.durable && this.kept === false;
  }

  /** Why the device stopped keeping this recording partway, or null while it keeps it. */
  refused(id: string): DeviceRefusal | null {
    return this.overflowed.get(id) ?? null;
  }

  /** A new recording, leased by this tab until `release`. */
  async create(init: NewRecording): Promise<StoredRecording> {
    const id = init.id ?? crypto.randomUUID();
    this.made.add(id);
    await this.lease(id);
    return this.change(async () => {
      const recording: StoredRecording = {
        ...init,
        id,
        startedAt: this.now(),
        durationMs: 0,
        state: "recording",
        parts: [],
        runId: null,
      };
      await this.write(recording);
      return recording;
    });
  }

  /** Starts a new part (a new audio file) and returns its index. */
  startPart(id: string): Promise<number> {
    return this.change(async () => {
      const recording = await this.require(id);
      const index = recording.parts.length;
      await this.write({
        ...recording,
        state: "recording",
        liveTranscriptId: null,
        parts: [
          ...recording.parts,
          { index, startedAt: this.now(), durationMs: 0, bytes: 0, chunks: 0, fileId: null },
        ],
      });
      return index;
    });
  }

  /** Stores the next chunk of a part; `durationMs` is the part's length so far. */
  append(id: string, part: number, data: Blob, durationMs: number): Promise<void> {
    return this.serial(async () => {
      const recording = await this.load(id);
      const current = recording?.parts[part];
      if (!recording || !current) throw new Error(NOT_ON_DEVICE);
      if (current.chunks === 0) this.heads.set(id, { part, data });
      const parts = recording.parts.map((p) =>
        p.index === part
          ? {
              ...p,
              chunks: p.chunks + 1,
              bytes: p.bytes + data.size,
              durationMs,
            }
          : p,
      );
      await this.write(
        { ...recording, parts, durationMs: parts.reduce((sum, p) => sum + p.durationMs, 0) },
        { recordingId: id, part, seq: current.chunks, data },
      );
    });
  }

  setState(id: string, state: RecordingState): Promise<void> {
    return this.update(id, (recording) => ({ ...recording, state }));
  }

  setPartFileId(id: string, part: number, fileId: string): Promise<void> {
    return this.update(id, (recording) => ({
      ...recording,
      parts: recording.parts.map((p) => (p.index === part ? { ...p, fileId, upload: null } : p)),
    }));
  }

  setPartEndConfirmed(id: string, part: number, endConfirmed: boolean): Promise<void> {
    return this.update(id, (recording) => ({
      ...recording,
      parts: recording.parts.map((p) => p.index === part ? { ...p, endConfirmed } : p),
    }));
  }

  /** The part's upload in parts was made or asked to complete; null once it is gone. */
  setPartUpload(id: string, part: number, upload: UploadHandle | null): Promise<void> {
    return this.update(id, (recording) => ({
      ...recording,
      parts: recording.parts.map((p) => (p.index === part ? { ...p, upload } : p)),
    }));
  }

  /** Eneo is about to be asked for the run: the request is kept first, and the send is "uploaded". */
  startSubmission(id: string, request: RunRequest): Promise<void> {
    return this.update(id, (recording) => ({ ...recording, state: "uploaded", submission: request }));
  }

  /**
   * Keeps a live session's stored transcript with the recording it heard whole: still one part, and no send begun,
   * which asked without it. Under the lease, so a send or a new part in another tab is never written over; a
   * recording in use is left as it is, and its run transcribes the audio.
   */
  async keepLiveTranscript(id: string, transcriptId: string): Promise<void> {
    if (!(await this.lease(id))) return;
    try {
      await this.change(async () => {
        const recording = await this.load(id);
        if (recording?.parts.length === 1 && !sealed(recording)) {
          await this.write({ ...recording, liveTranscriptId: transcriptId });
        }
      });
    } finally {
      this.release(id);
    }
  }

  /** Eneo will not use the live transcript: it is forgotten, and the request without it is the one kept. */
  dropLiveTranscript(id: string, request: RunRequest): Promise<void> {
    return this.update(id, (recording) => ({
      ...recording,
      state: "uploaded",
      submission: request,
      liveTranscriptId: null,
    }));
  }

  /** Drops a run request that can never be answered; the uploads stay, and the recording sealed. */
  forgetSubmission(id: string): Promise<void> {
    return this.update(id, (recording) => ({ ...recording, state: "uploading", submission: null }));
  }

  /** Forgets the uploads, and the run request made of them. */
  clearFileIds(id: string): Promise<void> {
    return this.update(id, (recording) => ({
      ...recording,
      parts: recording.parts.map((p) => ({ ...p, fileId: null, upload: null })),
      submission: null,
    }));
  }

  get(id: string): Promise<StoredRecording | null> {
    return this.serial(async () => (await this.load(id)) ?? null);
  }

  /** Recordings Eneo has not accepted as a run, newest first, except those being captured. */
  listUnsent(ownerId: string): Promise<StoredRecording[]> {
    return this.listUnsentGroups(ownerId).then(({ offered }) => offered);
  }

  /** Unsent recordings another tab holds now (it records, shows, sends or deletes one): told of, never offered here. */
  listHeldElsewhere(ownerId: string): Promise<StoredRecording[]> {
    return this.listUnsentGroups(ownerId).then(({ elsewhere }) => elsewhere);
  }

  /** One recording and lock snapshot, so a lease moving between tabs cannot put a recording into both groups. */
  listUnsentGroups(ownerId: string): Promise<{ offered: StoredRecording[]; elsewhere: StoredRecording[] }> {
    return this.serial(async () => {
      const locks = await this.env.locks?.query().catch(() => null);
      const held = new Set(locks?.held?.map((lock) => lock.name) ?? []);
      const recordings = (await this.all())
        .filter(
          (r) =>
            r.ownerId === ownerId &&
            r.state !== "submitted" &&
            !this.inUse.has(r.id),
        )
        .sort((a, b) => b.startedAt - a.startedAt);
      const groups: { offered: StoredRecording[]; elsewhere: StoredRecording[] } = { offered: [], elsewhere: [] };
      for (const recording of recordings) {
        // A lock this tab keeps is its own; any other held lock is another tab's.
        const elsewhere = !this.leases.has(recording.id) && held.has(lockName(recording.id));
        groups[elsewhere ? "elsewhere" : "offered"].push(recording);
      }
      return groups;
    });
  }

  /** Each part with audio as one file, in part order; WebM carries its recorded duration. What survived, whole or not. */
  readParts(id: string): Promise<RecordingFile[]> {
    return this.serial(async () => (await this.readEach(id)).filter((file) => file.blob.size > 0));
  }

  /**
   * The recording's file at `nth` of its files (its parts with audio, filesIn), read alone: Spara ljudfil saves one a
   * press. Null when the recording has no such file, or its audio is gone from the device.
   */
  readFile(id: string, nth: number): Promise<RecordingFile | null> {
    return this.serial(async () => {
      const recording = await this.load(id);
      const part = recording?.parts.filter((p) => p.bytes > 0)[nth];
      if (!recording || !part) return null;
      const file = await this.readPart(recording, part);
      return file.blob.size > 0 ? file : null;
    });
  }

  /**
   * The parts to send: each part with every chunk the recording counted (sequence 0 up to its last, and as many bytes),
   * or the integrity error, so that what is left on the device never goes to Eneo as if it were all of it, and the local
   * copy is never deleted for it. A part with no chunk left is a gap too, not a part to leave out.
   */
  readPartsToSend(id: string): Promise<RecordingFile[]> {
    return this.serial(async () => {
      const recording = await this.load(id);
      if (recording?.parts.some((part) => part.endConfirmed === false)) {
        throw new Error("Webbläsaren har inte bekräftat inspelningens stopp. Spara ljudet som fil för att behålla det och ladda upp filen i en ny inspelning.");
      }
      const files = await this.readEach(id);
      if (files.some((file) => !file.whole)) throw new Error(INCOMPLETE_ON_DEVICE);
      return files.filter((file) => file.blob.size > 0);
    });
  }

  private async readEach(id: string): Promise<Array<RecordingFile & { whole: boolean }>> {
    const recording = await this.load(id);
    if (!recording) return [];
    const files: Array<RecordingFile & { whole: boolean }> = [];
    // One part at a time: only one part's audio is in memory while it becomes a file (hours of a meeting, on a phone).
    for (const part of recording.parts) files.push(await this.readPart(recording, part));
    return files;
  }

  /**
   * One part as a file, whole or as far as it survived. The device's chunks are read a batch at a time, and each batch
   * goes to the browser as a Blob before the next is read: a meeting of hours is never in the tab whole.
   */
  private async readPart(recording: StoredRecording, part: RecordingPart): Promise<RecordingFile & { whole: boolean }> {
    const type = baseMimetype(recording.mimeType);
    // What this tab holds follows what the database has (it goes back onto the device only whole). The database's
    // are read first and an unreadable database is the read's failure: audio held in this tab is never taken for all
    // there is, and both copies stay.
    let stored = await this.backend.chunks(recording.id, part.index, 0, READ_BATCH);
    // By sequence number, once each: a chunk the device reported as refused but did keep is not played twice.
    const here = [...new Map((await this.overflow.chunks(recording.id, part.index)).map((chunk) => [chunk.seq, chunk])).values()];
    let next = 0;
    let count = 0;
    let bytes = 0;
    let inOrder = true;
    let held: Array<Chunk["data"]> = [];
    const files: Blob[] = [];
    const take = (chunk: Chunk) => {
      inOrder &&= chunk.seq === count;
      count += 1;
      bytes += chunk.data instanceof Blob ? chunk.data.size : chunk.data.byteLength;
      held.push(chunk.data);
    };
    // Safari's WebM is made seekable in Chromium as it goes.
    const keyframes = keyframeMarker(type);
    const handOver = async (last = false) => {
      const data = await keyframes(held, last);
      held = [];
      if (data.length === 0) return;
      // A WebM file's first chunk holds its whole header, where its recorded duration goes; MP4 carries its own.
      if (files.length === 0) data[0] = await withRecordedDuration(data[0], part.durationMs, type);
      files.push(new Blob(data));
    };
    for (;;) {
      for (const chunk of stored) {
        while (next < here.length && here[next].seq < chunk.seq) take(here[next++]);
        if (next < here.length && here[next].seq === chunk.seq) next += 1;
        take(chunk);
      }
      await handOver();
      if (stored.length < READ_BATCH) break;
      stored = await this.backend.chunks(recording.id, part.index, stored[stored.length - 1].seq + 1, READ_BATCH);
    }
    while (next < here.length) take(here[next++]);
    await handOver(true);
    const whole = count === part.chunks && inOrder && bytes === part.bytes;
    return { index: part.index, blob: new Blob(files, { type }), filename: recordingFilename(recording, part.index), whole };
  }

  /** Eneo accepted the run: the local copy is no longer needed. */
  accept(id: string, runId: string): Promise<void> {
    return this.change(async () => {
      const recording = await this.load(id);
      // The UI may have stopped waiting, but this recorder still owns audio that could arrive after an upload.
      if (recording?.parts.some((part) => part.endConfirmed === false)) return;
      // The device's copy says "submitted": what this tab holds is no longer needed.
      let marked = false;
      if (recording) {
        const accepted: StoredRecording = { ...recording, state: "submitted", runId };
        await this.write(accepted);
        // The device's copy says so too, also when the rest lived only in this tab: a reload never offers it.
        marked = !this.overflowed.has(id) || (await this.backend.put(accepted).then(() => true, () => false));
      }
      // A copy left by a failed delete is "submitted": never offered again, and deleted when the store next opens.
      await this.delete(id).catch(() => (marked ? this.forget(id) : undefined));
    });
  }

  /** Deletes what a failed delete left of recordings Eneo accepted; only "submitted" ones, which only `accept` writes. */
  removeAccepted(): Promise<void> {
    return this.change(async () => {
      for (const recording of await this.all()) {
        if (recording.state === "submitted") await this.delete(recording.id).catch(() => undefined);
      }
    });
  }

  /** Deletes a recording whose lease the caller holds: a start that recorded nothing. */
  discard(id: string): Promise<void> {
    return this.change(() => this.delete(id));
  }

  /** The user deleted the recording; refused while another tab uses it. */
  async remove(id: string): Promise<void> {
    if (!(await this.lease(id))) throw new Error(IN_USE_ELSEWHERE);
    try {
      await this.change(() => this.delete(id));
    } finally {
      this.release(id);
    }
  }

  /** Whether this tab may send, continue or delete it: without Web Locks only the tab that made it may. */
  mayChange(id: string): boolean {
    return this.env.locks !== undefined || this.made.has(id);
  }

  /** Takes the recording's lease for an operation in this tab; false while another operation or tab holds it. */
  lease(id: string): Promise<boolean> {
    if (this.inUse.has(id)) return Promise.resolve(false);
    this.inUse.add(id);
    // Kept for audio only this tab has: this tab's next send or delete takes it over.
    if (this.leases.has(id)) return Promise.resolve(true);
    const locks = this.env.locks;
    // Without Web Locks nothing keeps two tabs apart, so only a recording this
    // tab made changes here; any other is only read (saved as a file).
    const inThisTab = () => {
      if (!this.made.has(id)) {
        this.inUse.delete(id);
        return false;
      }
      this.leases.set(id, () => {});
      return true;
    };
    if (!locks) return Promise.resolve(inThisTab());
    return new Promise((resolve) => {
      locks
        .request(lockName(id), { ifAvailable: true }, (lock) => {
          if (!lock) {
            this.inUse.delete(id);
            return resolve(false);
          }
          // Held until `release` settles this promise.
          return new Promise<void>((end) => {
            this.leases.set(id, end);
            resolve(true);
          });
        })
        // A browser that refuses Web Locks here still leases within this tab.
        .catch(() => resolve(inThisTab()));
    });
  }

  release(id: string): void {
    if (!this.inUse.delete(id)) return;
    // Part of its audio is only in this tab: no other tab may send or delete it without that part. A held recording is
    // on this tab's screen.
    this.releaseUnusedLease(id);
    this.notify();
  }

  /** A stopped recording the page shows keeps its lease through `release`, until `letGo` (or it is deleted). */
  hold(id: string): void {
    if (this.leases.has(id)) this.held.add(id);
  }

  /** The page no longer shows the recording: its lease ends, unless an operation is using it or part of it is only here. */
  letGo(id: string): void {
    if (!this.held.delete(id)) return;
    this.releaseUnusedLease(id);
    this.notify();
  }

  /** A recorder owns late writes until its real stop event and queued storage writes have ended. */
  retainWriter(id: string): () => void {
    this.writers.set(id, (this.writers.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.writers.get(id) ?? 1) - 1;
      if (left > 0) this.writers.set(id, left);
      else this.writers.delete(id);
      this.releaseUnusedLease(id);
      this.notify();
    };
  }

  private releaseUnusedLease(id: string): void {
    if (!this.inUse.has(id) && !this.overflowed.has(id) && !this.held.has(id) && !this.writers.has(id)) this.dropLease(id);
  }

  private dropLease(id: string): void {
    this.leases.get(id)?.();
    this.leases.delete(id);
    this.live.delete(id);
  }

  /** What the browser already says of keeping this device's storage; nothing is asked of the user. */
  async readPersisted(): Promise<void> {
    try {
      this.kept = (await this.env.storage?.persisted?.()) ?? this.kept;
    } catch {
      // Not said: not claimed.
    }
  }

  async requestPersistence(): Promise<void> {
    // Once a page: Firefox asks the person in a bar over the page each time, and a refusal stands for the page.
    if (this.kept || this.askedToKeep) return;
    this.askedToKeep = true;
    try {
      const granted = await this.env.storage?.persist();
      if (granted === undefined || granted === this.kept) return;
      this.kept = granted;
      this.notify();
    } catch {
      // The browser may refuse; the recording is still stored.
    }
  }

  /** Whether the browser's estimate leaves little room; an estimate with room tries a device that refused again at once. */
  async lowOnSpace(): Promise<boolean> {
    let room: number | null = null;
    try {
      const estimate = await this.env.storage?.estimate();
      if (estimate?.quota != null && estimate.usage != null) room = estimate.quota - estimate.usage;
    } catch {
      // Not said: not low.
    }
    if (room !== null && room >= LOW_SPACE_BYTES && this.retriable().length > 0) void this.retryRefused();
    return room !== null && room < LOW_SPACE_BYTES;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private now(): number {
    return (this.env.now ?? Date.now)();
  }

  private notify() {
    this.listeners.forEach((listener) => listener());
  }

  /** Runs reads and writes one at a time, so chunks land in arrival order. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private change<T>(work: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      const value = await work();
      this.notify();
      return value;
    });
  }

  private update(id: string, patch: (recording: StoredRecording) => StoredRecording) {
    return this.change(async () => this.write(patch(await this.require(id))));
  }

  private async require(id: string): Promise<StoredRecording> {
    const recording = await this.load(id);
    if (!recording) throw new Error(NOT_ON_DEVICE);
    return recording;
  }

  private async load(id: string): Promise<StoredRecording | undefined> {
    if (this.overflowed.has(id)) return this.overflow.get(id);
    const copy = this.live.get(id);
    if (!copy) return this.backend.get(id);
    let stored: StoredRecording | undefined;
    try {
      stored = await this.backend.get(id);
    } catch {
      return copy;
    }
    return stored ?? this.lost(id, copy);
  }

  /**
   * The device no longer has a recording this tab is writing (the browser's data was cleared, or it took the storage
   * back): what came before is gone with it. The recording goes on in this tab, from the header of the part being
   * recorded and what follows it, and is said to be kept here only.
   */
  private async lost(id: string, copy: StoredRecording): Promise<StoredRecording> {
    const head = this.heads.get(id);
    const parts = copy.parts.map((part) =>
      head?.part === part.index ? { ...part, chunks: 1, bytes: head.data.size } : { ...part, chunks: 0, bytes: 0 },
    );
    const kept = { ...copy, parts };
    this.overflowed.set(id, "lost");
    await this.overflow.put(kept, head ? [{ recordingId: id, part: head.part, seq: 0, data: head.data }] : []);
    return kept;
  }

  private async all(): Promise<StoredRecording[]> {
    const byId = new Map<string, StoredRecording>();
    for (const r of await this.backend.list()) byId.set(r.id, r);
    for (const r of await this.overflow.list()) byId.set(r.id, r);
    return [...byId.values()];
  }

  private async write(recording: StoredRecording, chunk?: Chunk): Promise<void> {
    if (this.leases.has(recording.id)) this.live.set(recording.id, recording);
    const chunks = chunk ? [chunk] : [];
    if (!this.overflowed.has(recording.id)) {
      try {
        await this.backend.put(recording, chunks);
        return;
      } catch (error) {
        // A full disk, or a database that failed on a new connection too: the rest is kept in this tab until the device
        // takes it again.
        this.overflowed.set(recording.id, quotaExceeded(error) ? "full" : "failed");
        this.retryLater();
      }
    }
    await this.overflow.put(recording, chunks);
  }

  /** The recordings the device refused (full, or failed) and may take again; never one whose copy there is gone. */
  private retriable(): string[] {
    return [...this.overflowed].filter(([, why]) => why !== "lost").map(([id]) => id);
  }

  /** A device that refused is tried again in RETRY_MS: one timer, however many chunks it refuses meanwhile. */
  private retryLater(): void {
    if (this.retrying || !this.env.timer) return;
    this.retrying = true;
    this.env.timer(() => {
      this.retrying = false;
      void this.retryRefused();
    }, RETRY_MS);
  }

  /** In the queue, so no chunk comes between: what the device refused goes onto it, and is tried again while it refuses. */
  private retryRefused(): Promise<void> {
    return this.change(async () => {
      for (const id of this.retriable()) await this.flush(id);
      if (this.retriable().length > 0) this.retryLater();
    });
  }

  /**
   * What this tab holds of a recording goes onto the device in one write: the recording as it is now and every chunk
   * held here, so the device's copy is whole or as it was, also after a crash in the middle. Then the recording is kept
   * on the device again, and this tab lets its copy and the lease for it go.
   */
  private async flush(id: string): Promise<void> {
    const recording = await this.overflow.get(id);
    if (!recording) return;
    // ponytail: one write, so the device needs room for all of it at once (about 15 MB per hour held at 32 kbit/s);
    // writing it in pieces needs a recording that says how much of it the device has.
    const held = (await Promise.all(recording.parts.map((part) => this.overflow.chunks(id, part.index)))).flat();
    try {
      await this.backend.put(recording, held);
    } catch {
      return; // Still no room: kept here, and tried again.
    }
    this.overflowed.delete(id);
    await this.overflow.delete(id);
    this.releaseUnusedLease(id);
  }

  private async delete(id: string): Promise<void> {
    // The device's copy first: what this tab holds goes only once that is gone, so a failed delete leaves no
    // older copy to come back as the recording.
    await this.backend.delete(id);
    await this.forget(id);
  }

  /** What this tab holds of the recording. */
  private async forget(id: string): Promise<void> {
    this.live.delete(id);
    this.held.delete(id);
    this.heads.delete(id);
    this.overflowed.delete(id);
    await this.overflow.delete(id);
  }
}

export async function openRecordingStore(env: StoreEnv): Promise<RecordingStore> {
  if (env.indexedDB && env.keyRange) {
    try {
      const factory = env.indexedDB;
      const db = await openDatabase(factory);
      const store = new RecordingStore(idbBackend(db, env.keyRange, () => openDatabase(factory)), true, env);
      await store.removeAccepted().catch(() => undefined);
      await store.readPersisted();
      return store;
    } catch {
      // Private mode or blocked storage: fall through to memory.
    }
  }
  return new RecordingStore(memoryBackend(), false, env);
}

let shared: Promise<RecordingStore> | null = null;

/** The browser's recording store, opened once per tab. */
export function recordingStore(): Promise<RecordingStore> {
  shared ??= openRecordingStore({
    indexedDB: globalThis.indexedDB,
    keyRange: globalThis.IDBKeyRange,
    storage: globalThis.navigator?.storage,
    locks: globalThis.navigator?.locks,
    timer: (run, ms) => void setTimeout(run, ms),
  });
  return shared;
}
