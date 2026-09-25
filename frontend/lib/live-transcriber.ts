/**
 * Strömma's live text: the recording's audio, as 16 kHz PCM16 frames, goes to
 * the module's relay on the page's own origin (/api/live/{flowId}/{stepId},
 * no subprotocol), and the relay's words come back as a draft. The recorder
 * keeps the audio on the device the whole time; nothing here touches it, and
 * a live-text failure only changes this client's status.
 *
 * The relay's contract: wait for `ready` {sample_rate, max_seconds}, send
 * binary frames of at most 64 KiB, end with {"type":"stop", produced_samples};
 * it answers `transcript.delta` {text}, `transcript.done` {text,
 * transcript_id?} and `error` {code, message, retryable}. A refused handshake
 * (signed out, wrong origin) shows only as close 1006; 1011 means Eneo's
 * socket broke. The address may name the recording (?recording_id=): Eneo
 * then keeps the text of a session that heard all of it, as transcript_id.
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
  /** A sentence after a pause, or after a long paragraph; or live text after a break. */
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
  /** After the stop, the relay's final text came and the draft is it; false when the connection ended first. */
  complete: boolean;
  /** Eneo's stored transcript of the whole recording, from the final text of a recording heard whole. */
  transcriptId?: string;
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
// A pause in the words commits the whole words so far. A paragraph starts at a sentence's end after a longer
// pause, or once the paragraph holds five sentences or a minute of speech.
const COMMIT_AFTER_MS = 2_000;
const PARAGRAPH_AFTER_MS = 4_000;
const PARAGRAPH_SENTENCES = 5;
const PARAGRAPH_MS = 60_000;
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
// Tries before the first session was live; after that, live text keeps trying.
const START_ATTEMPTS = 3;
// How long a stop waits, in the background, for the relay's final text: Eneo's allowance for it
// (flow_live_transcription_final_text_timeout_seconds, 60 s by default).
const FINAL_TEXT_WAIT_MS = 60_000;
const SENTENCE_END = /[.!?…]["”'’)\]]*\s*$/;
const SENTENCE_ENDS = /[.!?…]["”'’)\]]*(?=\s|$)/g;

/** wss://host/api/live/{flowId}/{stepId} on the page's own origin, naming the recording when there is one. */
export function liveSocketUrl(
  location: { protocol: string; host: string },
  flowId: string,
  stepId: string,
  recordingId?: string,
): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const query = recordingId ? `?recording_id=${encodeURIComponent(recordingId)}` : "";
  return `${scheme}//${location.host}/api/live/${encodeURIComponent(flowId)}/${encodeURIComponent(stepId)}${query}`;
}

/** No subprotocol: the BFF selects none, and a browser fails a handshake that offered one. */
export function openLiveSocket(Socket: typeof WebSocket, url: string): LiveSocket {
  return new Socket(url) as unknown as LiveSocket;
}

type Failure = "retry" | "refused" | "idle" | null;

export class LiveTranscriber {
  private snapshot: LiveSnapshot = { status: "connecting", pieces: [], pending: "", started: false, complete: false };
  // The first piece of the current session: its final text replaces the session's pieces.
  private sessionStart = 0;
  private listeners = new Set<() => void>();
  private socket: LiveSocket | null = null;
  private ready = false;
  private buffered: ArrayBuffer[] = [];
  // Samples the recording gave live text. Only a recording heard whole, by one connection with no audio lost on the
  // way, sends the count and keeps its transcript; anything else makes its text a preview, for good.
  private produced = 0;
  private whole = true;
  private opened = false;
  private recording = true;
  private stopping = false;
  private failure: Failure = null;
  private attempts = 0;
  private retryMs = FIRST_RETRY_MS;
  private retryTimer: unknown = null;
  private commitTimer: unknown = null;
  private stopTimer: unknown = null;
  private lastWordsAt: number | null = null;
  // The start, or a break: the next piece opens a paragraph. After a pause in speech, one opens at a sentence's end.
  private opensParagraph = true;
  private paused = false;
  private paragraph = { sentences: 0, since: 0 };
  private stopListening: (() => void) | null = null;
  private stopFollowingLogin: (() => void) | null = null;

  /** `earlier`: the draft before Stoppa, when "Fortsätt spela in" goes on with the same recording. */
  constructor(
    private readonly deps: LiveDeps,
    earlier: LivePiece[] = [],
  ) {
    this.snapshot = { ...this.snapshot, pieces: earlier };
  }

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

  /**
   * The next 100 ms of audio; sent when live, kept (bounded) until then. Audio gathered before a pause may still
   * come after it: the audio pipeline, not this client, holds the pause.
   */
  pushFrame(frame: ArrayBuffer): void {
    if (this.stopping) return;
    // Counted before any wait or discard, so Eneo can tell whether the session heard all of it.
    this.produced += frame.byteLength / 2;
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

  /** The recorder paused or went on: paused, no new try starts, and a session silence ended starts again. */
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
      // A recording not heard whole names no count, and Eneo keeps no text.
      const stop = this.whole ? { type: "stop", produced_samples: this.produced } : { type: "stop" };
      this.socket.send(JSON.stringify(stop));
      this.stopTimer = this.deps.setTimer(() => this.finish(), FINAL_TEXT_WAIT_MS);
    } else {
      this.finish();
    }
  }

  /** Some of the recording's audio never reached live text: its text stays a preview. */
  lose(): void {
    this.whole = false;
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
    this.lose();
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
    // A second connection, before or after a ready: the first may have heard audio this one never gets.
    if (this.opened) this.lose();
    this.opened = true;
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
    let event: { type?: unknown; text?: unknown; code?: unknown; retryable?: unknown; transcript_id?: unknown };
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
        this.commit();
        this.sessionStart = this.snapshot.pieces.length;
        this.set({ status: "live", started: true });
        break;
      case "transcript.delta":
        this.addWords(typeof event.text === "string" ? event.text : "");
        break;
      case "transcript.done": {
        this.commit();
        // Only the relay's text, empty or not, is final; without it the deltas' words stay, unfinished.
        const final = typeof event.text === "string" ? event.text : null;
        if (final !== null) this.reconcile(final);
        if (this.stopping) {
          // Only a recording heard whole has a stored transcript of all of it.
          const transcriptId = this.whole && typeof event.transcript_id === "string" ? event.transcript_id : undefined;
          if (final !== null) this.set({ complete: true, transcriptId });
          this.finish();
        }
        break;
      }
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
    const now = this.now();
    if (this.lastWordsAt !== null && now - this.lastWordsAt >= PARAGRAPH_AFTER_MS) this.paused = true;
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
      // The last word may still be arriving ("kommunst"): it waits for the next words, a sentence's end or the stop.
      this.commit(this.snapshot.pending.search(/\s\S*$/));
    }, COMMIT_AFTER_MS);
  }

  /** The session's whole text, which the relay sends last: it replaces what the session's deltas said, empty too. */
  private reconcile(text: string) {
    const final = text.replace(/\s+/g, " ").trim();
    const session = this.snapshot.pieces.slice(this.sessionStart);
    if (session.map((piece) => piece.text).join(" ").replace(/\s+/g, " ") === final) return;
    if (!final) {
      this.set({ pieces: this.snapshot.pieces.slice(0, this.sessionStart) });
      return;
    }
    const opensParagraph = session[0]?.opensParagraph ?? (this.opensParagraph || this.sessionStart === 0);
    this.set({ pieces: [...this.snapshot.pieces.slice(0, this.sessionStart), { text: final, opensParagraph }] });
    this.opensParagraph = false;
  }

  /** The words so far become a piece: all of them, or those before `upTo`, the rest still pending. */
  private commit(upTo = this.snapshot.pending.length) {
    this.clear("commitTimer");
    const cut = Math.max(upTo, 0);
    const text = this.snapshot.pending.slice(0, cut).trim();
    const pending = this.snapshot.pending.slice(cut);
    if (!text) {
      if (pending !== this.snapshot.pending) this.set({ pending });
      return;
    }
    const now = this.now();
    const last = this.snapshot.pieces.at(-1);
    const long = this.paragraph.sentences >= PARAGRAPH_SENTENCES || now - this.paragraph.since >= PARAGRAPH_MS;
    const opensParagraph = this.opensParagraph || !last || (SENTENCE_END.test(last.text) && (this.paused || long));
    const sentences = text.match(SENTENCE_ENDS)?.length ?? 0;
    this.paragraph = opensParagraph
      ? { sentences, since: now }
      : { sentences: this.paragraph.sentences + sentences, since: this.paragraph.since };
    this.opensParagraph = false;
    this.paused = false;
    this.set({ pieces: [...this.snapshot.pieces, { text, opensParagraph }], pending });
  }

  private now() {
    return (this.deps.now ?? Date.now)();
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
