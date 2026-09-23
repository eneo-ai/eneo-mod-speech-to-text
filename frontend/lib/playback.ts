/**
 * One recording played as a whole over its parts: the model behind
 * AudioPlayer's controls. It drives one audio element, knows each part's
 * length (from the recorder, else from the audio's own metadata) and reports
 * where playback is, so a transcript can follow it and seek in it.
 */

export interface PlayerSource {
  url: string;
  /** Known from the recorder; null when only the audio's metadata can tell. */
  durationMs: number | null;
}

/** What playback needs of an audio element; a fake stands in for it in tests. */
export interface MediaLike {
  src: string;
  currentTime: number;
  duration: number;
  paused: boolean;
  playbackRate: number;
  play(): Promise<void>;
  pause(): void;
  load(): void;
}

export interface PlaybackSnapshot {
  /** The part playing, and the position within it. */
  part: number;
  withinMs: number;
  /** The position on the whole recording, and its length. */
  atMs: number;
  totalMs: number;
  /** The audio plays, as its own events tell. */
  playing: boolean;
  /** A start waits for the part's audio to load; toggle() and pause() cancel it. */
  starting: boolean;
  /** Playback has started or been moved; until then the position is only where it begins. */
  started: boolean;
  rate: number;
  /** The audio could not be played; reload() tries again. */
  unavailable: boolean;
  /** Each part's length as far as it is known. */
  lengthsMs: readonly number[];
}

/** A part's length from its header, or null when the audio cannot tell or the probe is cancelled. */
export function probeLength(url: string, signal?: AbortSignal): Promise<number | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(null);
    const audio = new Audio();
    const done = (ms: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      audio.onloadedmetadata = audio.onerror = null;
      // Without a source, a load stops the element's request.
      audio.removeAttribute("src");
      audio.load();
      resolve(ms);
    };
    const cancel = () => done(null);
    const timer = setTimeout(cancel, 10_000);
    signal?.addEventListener("abort", cancel);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1_000) : null);
    audio.onerror = cancel;
    audio.src = url;
  });
}

/** How many parts' lengths are probed at once. */
const PROBES_AT_ONCE = 3;

function ignore() {}

export class Playback {
  private sources: readonly PlayerSource[] = [];
  private media: MediaLike | null = null;
  /** The URL the element was last given; its own `src` reads back absolute. */
  private loaded: string | null = null;
  /** Lengths the audio's metadata gave, per part. */
  private learned: (number | null)[] = [];
  /** How far a part without a known length has played. */
  private seen: number[] = [];
  /** Parts whose audio a probe has asked for its length, whatever it told. */
  private probed = new Set<number>();
  /** The probes under way; cancelled when the element goes or other parts come. */
  private probing: AbortController | null = null;
  private part = 0;
  private withinMs = 0;
  private playing = false;
  private started = false;
  private rate = 1;
  private unavailable = false;
  /** Where to go once a part's audio has loaded, and whether to play on. */
  private pending: { withinMs: number; play: boolean } | null = null;
  /**
   * Range playback: pause when the part reaches this position, or its end first. Kept until the next move, as the
   * part's end can come right after the range's.
   */
  private stopAt: { part: number; ms: number } | null = null;
  private listeners = new Set<() => void>();
  private snapshot: PlaybackSnapshot;

  constructor(
    sources: readonly PlayerSource[] = [],
    private readonly probe: (url: string, signal: AbortSignal) => Promise<number | null> = probeLength,
  ) {
    this.sources = sources;
    this.snapshot = this.read();
  }

  getSnapshot = (): PlaybackSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** New parts reset playback; the same parts again change nothing. */
  setSources(sources: readonly PlayerSource[]): void {
    const same =
      sources.length === this.sources.length &&
      sources.every((s, i) => s.url === this.sources[i].url && s.durationMs === this.sources[i].durationMs);
    if (same) return;
    const sameUrls = sources.length === this.sources.length && sources.every((s, i) => s.url === this.sources[i].url);
    this.sources = sources;
    if (!sameUrls) {
      this.stopProbing();
      this.probed.clear();
      this.learned = [];
      this.seen = [];
      this.part = 0;
      this.withinMs = 0;
      this.started = false;
      this.pending = null;
      this.stopAt = null;
      this.unavailable = false;
      this.media?.pause();
      this.load(0, 0, false);
      this.probeUnknown();
    }
    this.emit();
  }

  /** The element React rendered, or null when it goes. */
  attach(media: MediaLike | null): void {
    if (media === this.media) return;
    this.media = media;
    this.loaded = null;
    if (media) {
      this.load(this.part, this.withinMs, false);
      this.probeUnknown();
    } else this.stopProbing();
  }

  // ---------- Controls ----------

  /** Moves to `withinMs` in `part`; `play` starts or keeps playing, and defaults to what the audio does now. */
  seek(part: number, withinMs: number, play = this.playingNow()): void {
    this.stopAt = null;
    this.started = true;
    if (this.sources.length === 0) {
      // A transcript without audio still has a playhead to highlight from.
      this.part = Math.max(0, part);
      this.withinMs = Math.max(0, withinMs);
      this.emit();
      return;
    }
    this.part = Math.min(Math.max(0, part), this.sources.length - 1);
    this.withinMs = this.clampWithin(this.part, withinMs);
    this.load(this.part, this.withinMs, play);
    this.emit();
  }

  /** A position on the whole recording, as the slider gives it. */
  seekAt(atMs: number): void {
    const { part, withinMs } = this.locate(atMs);
    this.seek(part, withinMs);
  }

  /** Plays `part` from `fromMs` and pauses at `toMs`. */
  playRange(part: number, fromMs: number, toMs: number): void {
    this.seek(part, fromMs, true);
    this.stopAt = { part: this.part, ms: toMs };
  }

  toggle(): void {
    const media = this.media;
    if (!media) return;
    this.stopAt = null;
    if (this.playingNow()) {
      this.pause();
      return;
    }
    if (this.atPartEnd()) {
      // At a part's end, where a passage can stop: the next part plays; after the last, the recording starts over.
      const next = this.part + 1;
      this.seek(next < this.sources.length ? next : 0, 0, true);
      return;
    }
    this.started = true;
    // A part still loading plays once it has loaded.
    if (this.pending) this.pending.play = true;
    else void media.play().catch(ignore);
    this.emit();
  }

  /** Pauses, also a start that waits for a part to load. */
  pause(): void {
    if (this.pending?.play) {
      // The load paused the element without a pause event, so none comes now either.
      this.pending.play = false;
      this.playing = false;
      this.emit();
    }
    this.media?.pause();
  }

  /** Moves by `deltaMs` over the whole recording; inside the part when its length is unknown. */
  skip(deltaMs: number): void {
    if (!this.known(this.part)) {
      this.seek(this.part, Math.max(0, this.withinMs + deltaMs));
      return;
    }
    const { part, withinMs } = this.locate(this.atMs() + deltaMs);
    this.seek(part, withinMs);
  }

  setRate(rate: number): void {
    this.rate = rate;
    if (this.media) this.media.playbackRate = rate;
    this.emit();
  }

  /** After an error: load the part again and come back to where it was. */
  reload(): void {
    this.unavailable = false;
    this.loaded = null;
    this.load(this.part, this.withinMs, false);
    this.emit();
  }

  // ---------- The element's events ----------

  onPlay = (): void => {
    this.playing = true;
    this.started = true;
    this.emit();
  };

  onPause = (): void => {
    this.playing = false;
    this.emit();
  };

  onLoadedMetadata = (): void => {
    const media = this.media;
    if (!media) return;
    this.learn(this.part, media.duration);
    media.playbackRate = this.rate;
    const next = this.pending;
    this.pending = null;
    if (next) {
      media.currentTime = next.withinMs / 1_000;
      if (next.play) void media.play().catch(ignore);
    }
    this.emit();
  };

  onDurationChange = (): void => {
    if (this.media && this.learn(this.part, this.media.duration)) this.emit();
  };

  onTimeUpdate = (): void => {
    const media = this.media;
    if (!media || this.pending) return;
    const ms = media.currentTime * 1_000;
    if (!this.known(this.part)) this.seen[this.part] = Math.max(this.seen[this.part] ?? 0, ms);
    this.withinMs = this.clampWithin(this.part, ms);
    if (this.stopAt && this.stopAt.part === this.part && ms >= this.stopAt.ms) media.pause();
    this.emit();
  };

  onEnded = (): void => {
    // A part nothing knew the length of has one now: where it ended.
    if (!this.known(this.part)) this.learned[this.part] = this.withinMs;
    // A passage stops at its part's end, also when it asked for more.
    const rangeEnds = this.stopAt?.part === this.part;
    this.stopAt = null;
    if (!rangeEnds && this.part < this.sources.length - 1) {
      this.part += 1;
      this.withinMs = 0;
      this.load(this.part, 0, true);
    } else {
      this.playing = false;
      this.withinMs = this.lengths()[this.part] ?? this.withinMs;
    }
    this.emit();
  };

  onError = (): void => {
    this.unavailable = true;
    this.playing = false;
    this.emit();
  };

  // ---------- Internals ----------

  private load(part: number, withinMs: number, play: boolean): void {
    const url = this.sources[part]?.url;
    if (!this.media || !url) {
      this.pending = null;
      return;
    }
    if (this.loaded === url) {
      if (this.pending) {
        // Still loading: land there once it has.
        this.pending = { withinMs, play };
        return;
      }
      this.media.currentTime = withinMs / 1_000;
      if (play) void this.media.play().catch(ignore);
      return;
    }
    this.pending = { withinMs, play };
    this.loaded = url;
    this.unavailable = false;
    this.media.src = url;
    this.media.load();
  }

  /** Asks the audio of the parts of unknown length for it, a few at a time, while the element is there. */
  private probeUnknown(): void {
    if (!this.media || this.probing) return;
    const run = new AbortController();
    this.probing = run;
    const sources = this.sources;
    // The loading part tells its own length.
    const queue = sources.flatMap((source, i) =>
      source.durationMs == null && this.learned[i] == null && !this.probed.has(i) && i !== this.part ? [i] : [],
    );
    const next = (): void => {
      const i = queue.shift();
      if (i === undefined || run.signal.aborted) return;
      if (this.learned[i] != null) return next();
      void this.probe(sources[i].url, run.signal)
        .catch(() => null)
        .then((ms) => {
          if (run.signal.aborted) return;
          this.probed.add(i);
          if (ms != null && this.learned[i] == null) {
            this.learned[i] = ms;
            this.emit();
          }
          next();
        });
    };
    for (let n = 0; n < PROBES_AT_ONCE; n++) next();
  }

  private stopProbing(): void {
    this.probing?.abort();
    this.probing = null;
  }

  /** Keeps a length the audio's metadata gave; true when it is new. */
  private learn(part: number, durationSeconds: number): boolean {
    if (this.sources[part]?.durationMs != null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return false;
    const ms = Math.round(durationSeconds * 1_000);
    if (this.learned[part] === ms) return false;
    this.learned[part] = ms;
    return true;
  }

  /** The element's own state: its pause event may not have arrived yet. */
  private playingNow(): boolean {
    if (this.pending) return this.pending.play;
    return this.media ? !this.media.paused : this.playing;
  }

  /** At the end of the current part; a length only seen so far is no end, the audio may go on. */
  private atPartEnd(): boolean {
    return this.known(this.part) && this.withinMs >= this.lengths()[this.part];
  }

  private known(part: number): boolean {
    return this.sources[part]?.durationMs != null || this.learned[part] != null;
  }

  private lengths(): number[] {
    return this.sources.map((s, i) => s.durationMs ?? this.learned[i] ?? this.seen[i] ?? 0);
  }

  private clampWithin(part: number, ms: number): number {
    const at = Math.max(0, ms);
    return this.known(part) ? Math.min(at, this.lengths()[part]) : at;
  }

  private atMs(): number {
    const lengths = this.lengths();
    let offset = 0;
    for (let i = 0; i < this.part && i < lengths.length; i++) offset += lengths[i];
    return offset + this.withinMs;
  }

  /** The part and position within it for a position on the whole recording. */
  private locate(atMs: number): { part: number; withinMs: number } {
    const lengths = this.lengths();
    const total = lengths.reduce((sum, ms) => sum + ms, 0);
    let rest = Math.min(Math.max(0, atMs), total);
    for (let i = 0; i < lengths.length; i++) {
      if (rest < lengths[i] || i === lengths.length - 1) return { part: i, withinMs: Math.min(rest, lengths[i]) };
      rest -= lengths[i];
    }
    return { part: 0, withinMs: 0 };
  }

  private read(): PlaybackSnapshot {
    const lengthsMs = this.lengths();
    return {
      part: this.part,
      withinMs: this.withinMs,
      atMs: this.atMs(),
      totalMs: lengthsMs.reduce((sum, ms) => sum + ms, 0),
      playing: this.playing,
      starting: this.pending?.play === true,
      started: this.started,
      rate: this.rate,
      unavailable: this.unavailable,
      lengthsMs,
    };
  }

  private emit(): void {
    this.snapshot = this.read();
    for (const listener of this.listeners) listener();
  }
}
