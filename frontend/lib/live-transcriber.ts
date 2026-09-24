/**
 * Strömma's live text: the recording's audio, as 16 kHz PCM16 frames, goes to
 * the module's relay on the page's own origin (/api/live/{flowId}/{stepId},
 * no subprotocol), and the relay's words come back as a draft. The recorder
 * keeps the audio on the device the whole time; nothing here touches it, and
 * a live-text failure only changes this client's status.
 *
 * The relay's contract: wait for `ready` {sample_rate, max_seconds}, send
 * binary frames of at most 64 KiB, end with {"type":"stop"}; it answers
 * `transcript.delta` {text}, `transcript.done` {text} and `error` {code,
 * message, retryable}. A refused handshake (signed out, wrong origin) shows
 * only as close 1006; 1011 means Eneo's socket broke.
 */

import type { OnlineStatus } from "./online-status";

/**
 * connecting: waiting for the first `ready`; live: text arrives;
 * reconnecting: a break, trying again (or waiting for the connection);
 * unavailable: refused at the start; stopped: ended mid-way for good;
 * ended: the recording stopped.
 */
export type LiveStatus = "connecting" | "live" | "reconnecting" | "unavailable" | "stopped" | "ended";

export interface LivePiece {
  text: string;
  /** Speech resumed after a pause, or live text after a break. */
  opensParagraph: boolean;
}

export interface LiveSnapshot {
  status: LiveStatus;
  /** Committed pieces of the draft, in order: what a screen reader hears. */
  pieces: LivePiece[];
  /** Words still arriving; shown, not yet a piece. */
  pending: string;
  /** A session has been live at least once. */
  started: boolean;
}

/** What the client needs of a WebSocket. */
export interface LiveSocket {
  binaryType: string;
  /** Bytes sent but not yet on the network. */
  readonly bufferedAmount: number;
  send(data: string | ArrayBuffer): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
}

export interface LiveDeps {
  openSocket: () => LiveSocket;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  online?: OnlineStatus;
  /**
   * The page's login (loginState): covered while signed out or someone else is signed in. The relay takes
   * whoever's cookie the browser has then, so live text sends nothing and connects to nothing until the page's
   * own user is back; the recording goes on meanwhile.
   */
  login?: { readonly signedOut: boolean; subscribe(listener: () => void): () => void };
  now?: () => number;
}

// 30 s of 100 ms frames (about 1 MB) waits for `ready`; older audio is dropped.
const MAX_BUFFERED_FRAMES = 300;
// A connection with as much queued is not keeping up; a new session takes over.
const MAX_QUEUED_BYTES = MAX_BUFFERED_FRAMES * 3_200;
// A pause in the words commits the draft so far; a longer one starts a paragraph.
const COMMIT_AFTER_MS = 2_000;
const PARAGRAPH_AFTER_MS = 4_000;
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
// Tries before the first session was live; after that, live text keeps trying.
const START_ATTEMPTS = 3;
// How long a stop waits for the relay's last words.
const STOP_WAIT_MS = 5_000;
const SENTENCE_END = /[.!?…]["”'’)\]]*\s*$/;

/** wss://host/api/live/{flowId}/{stepId} on the page's own origin. */
export function liveSocketUrl(location: { protocol: string; host: string }, flowId: string, stepId: string): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/api/live/${encodeURIComponent(flowId)}/${encodeURIComponent(stepId)}`;
}

/** No subprotocol: the BFF selects none, and a browser fails a handshake that offered one. */
export function openLiveSocket(Socket: typeof WebSocket, url: string): LiveSocket {
  return new Socket(url) as unknown as LiveSocket;
}

type Failure = "retry" | "refused" | "idle" | null;

export class LiveTranscriber {
  private snapshot: LiveSnapshot = { status: "connecting", pieces: [], pending: "", started: false };
  private listeners = new Set<() => void>();
  private socket: LiveSocket | null = null;
  private ready = false;
  private buffered: ArrayBuffer[] = [];
  private recording = true;
  private stopping = false;
  private failure: Failure = null;
  private attempts = 0;
  private retryMs = FIRST_RETRY_MS;
  private retryTimer: unknown = null;
  private commitTimer: unknown = null;
  private stopTimer: unknown = null;
  private lastWordsAt: number | null = null;
  private opensParagraph = true;
  private stopListening: (() => void) | null = null;
  private stopFollowingLogin: (() => void) | null = null;

  constructor(private readonly deps: LiveDeps) {}

  getSnapshot = (): LiveSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    this.stopListening ??=
      this.deps.online?.subscribe((online) => {
        if (online && this.snapshot.status === "reconnecting" && this.recording) this.connect();
      }) ?? null;
    this.stopFollowingLogin ??=
      this.deps.login?.subscribe(() => {
        if (this.deps.login?.signedOut) this.cover();
        else if (this.snapshot.status === "reconnecting" && this.recording && this.retryTimer === null) this.connect();
      }) ?? null;
    this.connect();
  }

  /**
   * Covered for a new login: the connection is retired at once, as a break to come back from, also before its
   * first `ready`; connect() then waits for the page's own user.
   */
  private cover() {
    this.clear("retryTimer");
    this.fail();
  }

  /** The next 100 ms of audio; sent when live, kept (bounded) until then. */
  pushFrame(frame: ArrayBuffer): void {
    if (!this.recording || this.stopping) return;
    if (this.ready && this.socket) {
      if (this.socket.bufferedAmount + frame.byteLength <= MAX_QUEUED_BYTES) {
        this.socket.send(frame);
        return;
      }
      // Fallen behind: the connection is retired, and this audio waits for the next.
      this.fail();
    }
    const { status } = this.snapshot;
    if (status === "unavailable" || status === "stopped" || status === "ended") return;
    this.buffered.push(frame);
    if (this.buffered.length > MAX_BUFFERED_FRAMES) this.buffered.shift();
  }

  /** The recorder paused or went on: paused audio is not sent, and a session silence ended starts again. */
  setRecording(on: boolean): void {
    this.recording = on;
    // Paused, a new try waits for recording to go on.
    if (!on) this.clear("retryTimer");
    if (on && this.snapshot.status === "reconnecting" && this.retryTimer === null && !this.socket) this.connect();
  }

  /** The recording stopped: the last audio, then the stop message, and the draft is kept. */
  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.commit();
    this.clear("retryTimer");
    if (this.socket && this.ready) {
      this.socket.send(JSON.stringify({ type: "stop" }));
      this.stopTimer = this.deps.setTimer(() => this.finish(), STOP_WAIT_MS);
    } else {
      this.finish();
    }
  }

  /**
   * This connection cannot carry live text any further (it fell behind, or the
   * audio feeding it broke): it ends as a break, and live text tries again the
   * way it does after a dropped connection. The connection stays this
   * client's until the browser has closed it (a close still sends what was
   * queued), so nothing more goes to it and no replacement opens before its
   * own close event; the audio meanwhile waits in the bounded buffer.
   */
  fail(): void {
    const socket = this.socket;
    if (!socket || this.stopping) return;
    this.failure = "retry";
    this.ready = false;
    if (this.snapshot.started) this.set({ status: "reconnecting" });
    try {
      socket.close(1000);
    } catch {
      // Already closing.
    }
  }

  /** The page goes away. */
  dispose(): void {
    this.stopping = true;
    this.finish();
  }

  private connect() {
    // One connection at a time: an attempt under way is never replaced. None while paused or stopping.
    if (this.socket || !this.recording || this.stopping) return;
    // Covered for a new login: live text waits for the page's own user (see LiveDeps.login).
    if (this.deps.login?.signedOut) {
      this.clear("retryTimer");
      this.set({ status: "reconnecting" });
      return;
    }
    this.clear("retryTimer");
    this.ready = false;
    this.failure = null;
    this.attempts += 1;
    let socket: LiveSocket;
    try {
      socket = this.deps.openSocket();
    } catch {
      // The browser will not even open one (a bad address, a blocked scheme): no later try does better.
      this.giveUp(this.snapshot.started ? "stopped" : "unavailable");
      return;
    }
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => this.onMessage(socket, event.data);
    socket.onclose = () => this.onClose(socket);
    // A failed socket also closes; the close says what to do.
    socket.onerror = () => undefined;
    this.socket = socket;
    if (!this.snapshot.started) this.set({ status: "connecting" });
  }

  private onMessage(socket: LiveSocket, data: unknown) {
    if (socket !== this.socket) return;
    let event: { type?: unknown; text?: unknown; code?: unknown; retryable?: unknown };
    try {
      event = JSON.parse(String(data));
    } catch {
      return;
    }
    switch (event.type) {
      case "ready":
        this.ready = true;
        this.attempts = 0;
        this.retryMs = FIRST_RETRY_MS;
        this.buffered.forEach((frame) => socket.send(frame));
        this.buffered = [];
        this.set({ status: "live", started: true });
        break;
      case "transcript.delta":
        this.addWords(typeof event.text === "string" ? event.text : "");
        break;
      case "transcript.done":
        this.commit();
        if (this.stopping) this.finish();
        break;
      case "error":
        this.failure = event.code === "idle_timeout" ? "idle" : event.retryable === true ? "retry" : "refused";
        break;
    }
  }

  private onClose(socket: LiveSocket) {
    if (socket !== this.socket) return;
    this.socket = null;
    const wasReady = this.ready;
    this.ready = false;
    this.commit();
    if (this.stopping) {
      this.finish();
      return;
    }
    const { started } = this.snapshot;
    const failure = this.failure;
    if (failure === "refused") {
      this.giveUp(started ? "stopped" : "unavailable");
    } else if (failure === "idle" || failure === "retry" || wasReady || started) {
      this.retry();
    } else if (this.deps.online && !this.deps.online.online) {
      // Offline at the start: the connection coming back starts it.
      this.set({ status: "reconnecting" });
    } else {
      // Closed before any session said ready, without a reason: a refused
      // handshake (signed out, wrong origin) closes 1006 like this.
      this.giveUp("unavailable");
    }
  }

  private retry() {
    this.opensParagraph = true;
    if (!this.snapshot.started && this.attempts >= START_ATTEMPTS) {
      this.giveUp("unavailable");
      return;
    }
    this.set({ status: "reconnecting" });
    // Paused: the next session starts when recording goes on.
    if (!this.recording) return;
    this.retryTimer = this.deps.setTimer(() => {
      this.retryTimer = null;
      this.connect();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }

  private giveUp(status: "unavailable" | "stopped") {
    this.buffered = [];
    this.set({ status });
  }

  private addWords(text: string) {
    if (!text) return;
    const now = (this.deps.now ?? Date.now)();
    if (this.lastWordsAt !== null && now - this.lastWordsAt >= PARAGRAPH_AFTER_MS) this.opensParagraph = true;
    this.lastWordsAt = now;
    const pending = this.snapshot.pending + text;
    this.clear("commitTimer");
    this.set({ pending });
    if (SENTENCE_END.test(pending)) {
      this.commit();
      return;
    }
    this.commitTimer = this.deps.setTimer(() => {
      this.commitTimer = null;
      this.commit();
    }, COMMIT_AFTER_MS);
  }

  private commit() {
    this.clear("commitTimer");
    const text = this.snapshot.pending.trim();
    if (!text) {
      if (this.snapshot.pending) this.set({ pending: "" });
      return;
    }
    const piece = { text, opensParagraph: this.opensParagraph || this.snapshot.pieces.length === 0 };
    this.opensParagraph = false;
    this.set({ pieces: [...this.snapshot.pieces, piece], pending: "" });
  }

  private finish() {
    this.clear("retryTimer");
    this.clear("commitTimer");
    this.clear("stopTimer");
    this.commit();
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this.buffered = [];
    try {
      socket?.close(1000);
    } catch {
      // Already closing.
    }
    this.stopListening?.();
    this.stopListening = null;
    this.stopFollowingLogin?.();
    this.stopFollowingLogin = null;
    this.set({ status: "ended" });
  }

  private clear(timer: "retryTimer" | "commitTimer" | "stopTimer") {
    if (this[timer] === null) return;
    this.deps.clearTimer(this[timer]);
    this[timer] = null;
  }

  private set(patch: Partial<LiveSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}
