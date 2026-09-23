/**
 * The one owner of recordings on the device. Every MediaRecorder chunk is
 * stored in IndexedDB as it arrives, under the recording id, part and
 * sequence number; a part is a valid audio file when its chunks are joined in
 * order. A crash, reload or expired session therefore loses at most the latest
 * chunk. Without IndexedDB, or when the device refuses a write, the audio is
 * kept in memory and `persistent` turns false: the recording then lives only
 * in this tab.
 */

import { baseMimetype, extensionForAudioMime } from "./upload";
import { withWebmDuration } from "./webm-duration";

export type RecordingState =
  | "recording"
  | "paused"
  | "stopped"
  | "uploading"
  | "uploaded"
  | "submitted";

export type RecordingInputMode = "record" | "stream";

export interface RecordingPart {
  index: number;
  startedAt: number;
  durationMs: number;
  bytes: number;
  chunks: number;
  /** Eneo's file id once this part is uploaded. */
  fileId: string | null;
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
}

export type NewRecording = Pick<
  StoredRecording,
  "ownerId" | "flowId" | "flowName" | "stepId" | "inputMode" | "mimeType"
>;

/** One part as an audio file, ready to upload or save. */
export interface RecordingFile {
  index: number;
  blob: Blob;
  filename: string;
}

export interface StoreEnv {
  indexedDB?: IDBFactory;
  keyRange?: typeof IDBKeyRange;
  storage?: Pick<StorageManager, "estimate" | "persist">;
  locks?: Pick<LockManager, "request" | "query">;
  now?: () => number;
}

const DB_NAME = "tal-till-text";
const DB_VERSION = 1;
const RECORDINGS = "recordings";
const CHUNKS = "chunks";
// About three hours of speech at 64 kbit/s; below this the recorder warns.
const LOW_SPACE_BYTES = 100 * 1024 * 1024;

interface Chunk {
  recordingId: string;
  part: number;
  seq: number;
  data: Blob | ArrayBuffer;
}

interface Backend {
  put(recording: StoredRecording, chunk?: Chunk): Promise<void>;
  get(id: string): Promise<StoredRecording | undefined>;
  list(): Promise<StoredRecording[]>;
  chunks(id: string, part: number): Promise<Chunk[]>;
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

function idbBackend(db: IDBDatabase, keyRange: typeof IDBKeyRange): Backend {
  return {
    async put(recording, chunk) {
      // Safari cannot always store a Blob in IndexedDB; an ArrayBuffer works everywhere.
      const data = chunk?.data instanceof Blob ? await chunk.data.arrayBuffer() : chunk?.data;
      const tx = db.transaction([RECORDINGS, CHUNKS], "readwrite");
      const done = completion(tx);
      try {
        tx.objectStore(RECORDINGS).put(recording);
        if (chunk) tx.objectStore(CHUNKS).put({ ...chunk, data });
      } catch (error) {
        done.catch(() => undefined);
        tx.abort();
        throw error;
      }
      await done;
    },
    get: (id) => result(db.transaction(RECORDINGS).objectStore(RECORDINGS).get(id)),
    list: () => result(db.transaction(RECORDINGS).objectStore(RECORDINGS).getAll()),
    chunks: (id, part) =>
      result(
        db
          .transaction(CHUNKS)
          .objectStore(CHUNKS)
          .getAll(keyRange.bound([id, part, 0], [id, part, Infinity])),
      ),
    async delete(id) {
      const tx = db.transaction([RECORDINGS, CHUNKS], "readwrite");
      tx.objectStore(CHUNKS).delete(keyRange.bound([id, 0, 0], [id, Infinity, Infinity]));
      tx.objectStore(RECORDINGS).delete(id);
      await completion(tx);
    },
  };
}

function memoryBackend(): Backend {
  const recordings = new Map<string, StoredRecording>();
  const chunks = new Map<string, Chunk[]>();
  return {
    async put(recording, chunk) {
      recordings.set(recording.id, recording);
      if (chunk) chunks.set(recording.id, [...(chunks.get(recording.id) ?? []), chunk]);
    },
    get: async (id) => recordings.get(id),
    list: async () => [...recordings.values()],
    chunks: async (id, part) => (chunks.get(id) ?? []).filter((c) => c.part === part),
    async delete(id) {
      recordings.delete(id);
      chunks.delete(id);
    },
  };
}

const lockName = (id: string) => `tal-till-text-recording:${id}`;

export const IN_USE_ELSEWHERE = "Inspelningen används i en annan flik.";

/** Its capture ended without a stop (a reload, a killed tab): "Fortsätt spela in" adds a part. */
export function continuable(recording: StoredRecording): boolean {
  return recording.state === "recording" || recording.state === "paused";
}

/** `inspelning-2026-09-23-1012.webm`, with `-del-2` when there are several parts. */
export function recordingFilename(recording: StoredRecording, index: number): string {
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
 * Without Web Locks (Safari before 15.4) a lease covers only this tab.
 */
export class RecordingStore {
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  // Leases this tab holds (with how to end each), and this tab's latest copy
  // of those recordings. The database stays the truth, since without Web
  // Locks another tab may have changed or deleted a recording: the copy
  // serves only when the device cannot read.
  private leases = new Map<string, () => void>();
  private live = new Map<string, StoredRecording>();
  // What the device refused to store stays here, in this tab.
  private overflow = memoryBackend();
  private overflowed = new Set<string>();

  constructor(
    private backend: Backend,
    private durable: boolean,
    private env: StoreEnv,
  ) {}

  /** False when the audio (or part of it) lives only in this tab. */
  get persistent(): boolean {
    return this.durable && this.overflowed.size === 0;
  }

  /** A new recording, leased by this tab until `release`. */
  async create(init: NewRecording): Promise<StoredRecording> {
    const id = crypto.randomUUID();
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
      if (!recording || !current) return;
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
      parts: recording.parts.map((p) => (p.index === part ? { ...p, fileId } : p)),
    }));
  }

  clearFileIds(id: string): Promise<void> {
    return this.update(id, (recording) => ({
      ...recording,
      parts: recording.parts.map((p) => ({ ...p, fileId: null })),
    }));
  }

  get(id: string): Promise<StoredRecording | null> {
    return this.serial(async () => (await this.load(id)) ?? null);
  }

  /** Recordings Eneo has not accepted as a run, newest first, except those being captured. */
  listUnsent(ownerId: string): Promise<StoredRecording[]> {
    return this.serial(async () => {
      const locks = await this.env.locks?.query().catch(() => null);
      const heldElsewhere = new Set(locks?.held?.map((lock) => lock.name) ?? []);
      return (await this.all())
        .filter(
          (r) =>
            r.ownerId === ownerId &&
            r.state !== "submitted" &&
            !this.leases.has(r.id) &&
            !heldElsewhere.has(lockName(r.id)),
        )
        .sort((a, b) => b.startedAt - a.startedAt);
    });
  }

  /** Each part with audio as one file, in part order; WebM carries its recorded duration. */
  readParts(id: string): Promise<RecordingFile[]> {
    return this.serial(async () => {
      const recording = await this.load(id);
      if (!recording) return [];
      const type = baseMimetype(recording.mimeType);
      const files = await Promise.all(
        recording.parts.map(async (part) => {
          // Overflow is sticky, so its chunks always follow the database's.
          const data: Array<Blob | ArrayBuffer | Uint8Array> = [
            ...(await this.backend.chunks(id, part.index)),
            ...(await this.overflow.chunks(id, part.index)),
          ].map((chunk) => chunk.data);
          // A WebM file's first chunk holds its whole header; MP4 carries its own duration.
          if (data.length > 0) {
            const first = data[0];
            const header = new Uint8Array(first instanceof Blob ? await first.arrayBuffer() : first);
            data[0] = withWebmDuration(header, part.durationMs) ?? first;
          }
          return {
            index: part.index,
            blob: new Blob(data, { type }),
            filename: recordingFilename(recording, part.index),
          };
        }),
      );
      return files.filter((file) => file.blob.size > 0);
    });
  }

  /** Eneo accepted the run: the local copy is no longer needed. */
  accept(id: string, runId: string): Promise<void> {
    return this.change(async () => {
      const recording = await this.load(id);
      if (recording) await this.write({ ...recording, state: "submitted", runId });
      // A copy left by a failed delete is "submitted" and never offered again.
      await this.delete(id).catch(() => undefined);
    });
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

  /** Takes the recording's lease for this tab; false while any tab holds it. */
  lease(id: string): Promise<boolean> {
    if (this.leases.has(id)) return Promise.resolve(false);
    const locks = this.env.locks;
    const inThisTab = () => {
      this.leases.set(id, () => {});
      return true;
    };
    if (!locks) return Promise.resolve(inThisTab());
    return new Promise((resolve) => {
      locks
        .request(lockName(id), { ifAvailable: true }, (lock) => {
          if (!lock) return resolve(false);
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
    const end = this.leases.get(id);
    if (!end) return;
    this.leases.delete(id);
    this.live.delete(id);
    end();
    this.notify();
  }

  async requestPersistence(): Promise<void> {
    try {
      await this.env.storage?.persist();
    } catch {
      // The browser may refuse; the recording is still stored.
    }
  }

  async lowOnSpace(): Promise<boolean> {
    try {
      const estimate = await this.env.storage?.estimate();
      return (
        estimate?.quota != null &&
        estimate.usage != null &&
        estimate.quota - estimate.usage < LOW_SPACE_BYTES
      );
    } catch {
      return false;
    }
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
    if (!recording) throw new Error("Inspelningen finns inte längre på enheten.");
    return recording;
  }

  private async load(id: string): Promise<StoredRecording | undefined> {
    if (this.overflowed.has(id)) return this.overflow.get(id);
    const copy = this.live.get(id);
    if (!copy) return this.backend.get(id);
    try {
      return await this.backend.get(id);
    } catch {
      return copy;
    }
  }

  private async all(): Promise<StoredRecording[]> {
    const byId = new Map<string, StoredRecording>();
    for (const r of await this.backend.list()) byId.set(r.id, r);
    for (const r of await this.overflow.list()) byId.set(r.id, r);
    return [...byId.values()];
  }

  private async write(recording: StoredRecording, chunk?: Chunk): Promise<void> {
    if (this.leases.has(recording.id)) this.live.set(recording.id, recording);
    if (!this.overflowed.has(recording.id)) {
      try {
        await this.backend.put(recording, chunk);
        return;
      } catch {
        // Full disk or a lost database connection: keep the rest in this tab.
        this.overflowed.add(recording.id);
      }
    }
    await this.overflow.put(recording, chunk);
  }

  private async delete(id: string): Promise<void> {
    this.live.delete(id);
    this.overflowed.delete(id);
    await this.overflow.delete(id);
    await this.backend.delete(id);
  }
}

export async function openRecordingStore(env: StoreEnv): Promise<RecordingStore> {
  if (env.indexedDB && env.keyRange) {
    try {
      const db = await openDatabase(env.indexedDB);
      return new RecordingStore(idbBackend(db, env.keyRange), true, env);
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
  });
  return shared;
}
