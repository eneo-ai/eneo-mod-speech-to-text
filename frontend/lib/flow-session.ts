/**
 * The one owner of the flow page's input side: how the audio comes in
 * (Strömma, Spela in, Ladda upp), the details the flow asks for, the speaker
 * choice, and the phase from setup to a recording that is ready to become a
 * document. Capturing belongs to the RecordingCapture this class owns; the
 * phase is read from it and never copied. Upload, run and result belong to
 * the page's run code.
 */

import {
  ApiError,
  type FlowTranscriptionContract,
  type FormField,
  type RunContract,
  type RunContractStepInput,
} from "./api";
import { friendlyError } from "./errors";
import { splitNames } from "./participants";
import { RecordingCapture, type CaptureDeps, type CaptureLimits } from "./recording-session";
import { IN_USE_ELSEWHERE, type RecordingStore, type StoredRecording } from "./recording-store";
import { formatBytes } from "./format";
import type { LiveSnapshot } from "./live-transcriber";
import { baseMimetype, isMimeAllowed, isRuntimeFileInput, selectRuntimeInputStep } from "./upload";

export type InputMode = "stromma" | "spela-in" | "ladda-upp";
export type SessionPhase = "setup" | "starting" | "recording" | "paused" | "interrupted" | "ready";
export type DetailValue = string | string[];
export type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

/** What happened, and what to do next. */
export interface Problem {
  title: string;
  detail?: string;
  /** Offer "Försök igen". */
  retry?: boolean;
  /** Offer the way back to the flows. */
  back?: boolean;
}

export interface ChosenFile {
  blob: Blob;
  filename: string;
  /** Known once the browser has read the file's header. */
  durationMs?: number | null;
}

export interface SubmitRequest {
  input: { kind: "recording"; recording: StoredRecording } | ({ kind: "file" } & ChosenFile) | null;
  /** The details as the run's input_payload_json. */
  payload: Record<string, unknown>;
  /** Sent only when the contract lets the run choose. */
  speakerLabels: boolean | undefined;
}

export interface SessionHandlers {
  /** Uploads and starts the run; throws when it could not. */
  submit: (request: SubmitRequest) => Promise<void>;
  /** Loads the published flow and its run contract again. */
  reloadFlow?: () => Promise<void>;
}

const FORMAT_NAMES: Record<string, string> = {
  mpeg: "MP3",
  mp3: "MP3",
  wav: "WAV",
  "x-wav": "WAV",
  wave: "WAV",
  "vnd.wave": "WAV",
  mp4: "M4A",
  m4a: "M4A",
  "x-m4a": "M4A",
  aac: "AAC",
  webm: "WebM",
  ogg: "Ogg",
  flac: "FLAC",
  "x-flac": "FLAC",
};

/** "MP3, WAV, M4A och WebM": the flow's accepted types in plain words. */
export function acceptedFormats(mimetypes: string[] | undefined): string | null {
  const names = [
    ...new Set(
      (mimetypes ?? [])
        .map((mime) => baseMimetype(mime).split("/")[1] ?? "")
        .filter((subtype) => subtype && subtype !== "*")
        .map((subtype) => FORMAT_NAMES[subtype] ?? subtype.replace(/^x-/, "").toUpperCase()),
    ),
  ];
  if (names.length === 0) return null;
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} och ${names[names.length - 1]}`;
}

// The browser gives no type for some files; their name says enough.
const EXTENSION_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  wav: "audio/wav",
  webm: "audio/webm",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
};

function oversized(maxBytes: number): Problem {
  return {
    title: `Filen är större än flödet tar emot (högst ${formatBytes(maxBytes)}).`,
    detail: "Välj en kortare inspelning eller dela upp den.",
  };
}

function unsupported(accepted: string[] | undefined): Problem {
  const formats = acceptedFormats(accepted);
  return { title: "Filtypen stöds inte.", detail: formats ? `Flödet tar emot ${formats}.` : undefined };
}

/** Whether the flow's input step takes this file, said in plain words when it does not. */
export function fileProblem(
  file: { name: string; type: string; size: number },
  step: RunContractStepInput | null,
): Problem | null {
  const accepted = step?.accepted_mimetypes;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const type = file.type || EXTENSION_TYPES[extension] || "";
  if (type && !isMimeAllowed(type, accepted)) return unsupported(accepted);
  if (step?.max_file_size_bytes && file.size > step.max_file_size_bytes) return oversized(step.max_file_size_bytes);
  return null;
}

/** A failed send in the product's words, with the next step. */
export function submitProblem(
  error: unknown,
  step: RunContractStepInput | null,
  inputKind: "recording" | "file" | null,
): Problem {
  if (error instanceof ApiError) {
    if (error.code === "flow_run_stale_version") {
      return { title: "Flödet har uppdaterats sedan sidan öppnades. Kontrollera uppgifterna och välj Skapa dokument igen." };
    }
    if (error.status === 404 || error.code === "flow_not_published") {
      return {
        title: "Flödet är inte längre tillgängligt.",
        detail:
          inputKind === "recording"
            ? "Inspelningen finns kvar. Spara den som fil om du vill behålla den."
            : "Välj ett annat flöde.",
        back: true,
      };
    }
    if ((error.status === 413 || error.code === "file_too_large") && step?.max_file_size_bytes) {
      return oversized(step.max_file_size_bytes);
    }
    if (error.status === 415 || error.code === "unsupported_media_type") return unsupported(step?.accepted_mimetypes);
  }
  return { title: friendlyError(error) };
}

export interface SessionSnapshot {
  modes: InputMode[];
  mode: InputMode | null;
  phase: SessionPhase;
  details: Record<string, DetailValue>;
  /** Required details still missing when the document was asked for. */
  invalid: string[];
  /** The effective choice; null when the flow does not let the run choose. */
  speakerLabels: boolean | null;
  /** The recording being captured, or the stopped one that is ready. */
  recording: StoredRecording | null;
  /** The file chosen in Ladda upp. */
  file: ChosenFile | null;
  /** Strömma's live text for the recording, when there is one. */
  live: LiveSession | null;
  problem: Problem | null;
}

/** The ways this flow can take its audio, in the order the cards show them. */
export function availableModes(
  contract: RunContract | null,
  { canRecord, liveClient }: { canRecord: boolean; liveClient: boolean },
): InputMode[] {
  const step = selectRuntimeInputStep(contract);
  if (!step || !isRuntimeFileInput(step.input_format)) return [];
  if (step.input_format?.toLowerCase() !== "audio") return ["ladda-upp"];
  const modes: InputMode[] = [];
  if (canRecord && liveClient && contract?.transcription?.live.available) modes.push("stromma");
  if (canRecord) modes.push("spela-in");
  modes.push("ladda-upp");
  return modes;
}

/** Live text is a draft, so speaker labels only add waiting there unless asked for. */
export function speakerLabelsFor(
  option: FlowTranscriptionContract["speaker_labels"] | null | undefined,
  mode: InputMode | null,
  explicit: boolean | null,
): boolean | null {
  if (!option?.selectable) return null;
  if (explicit !== null) return explicit;
  return mode === "stromma" ? false : option.default;
}

/** Claims the recording is kept on the device only when the device store keeps it. */
export function storageLine(persistent: boolean | null): string {
  return persistent
    ? "Inspelningen sparas på enheten medan du spelar in."
    : "Låt sidan vara öppen under inspelningen.";
}

export function primaryActionLabel(mode: InputMode, hasFile: boolean): string {
  if (mode === "stromma") return "Starta strömning";
  if (mode === "spela-in") return "Starta inspelning";
  return hasFile ? "Skapa dokument" : "Välj ljudfil";
}

export function microphoneProblem(errorName: string | null): Problem {
  switch (errorName) {
    case "NotAllowedError":
    case "SecurityError":
      return {
        title: "Appen fick inte använda mikrofonen.",
        detail: "Tillåt mikrofonen i webbläsarens inställningar och försök igen.",
        retry: true,
      };
    case "NotFoundError":
    case "OverconstrainedError":
      return {
        title: "Ingen mikrofon hittades.",
        detail: "Anslut en mikrofon eller välj Ladda upp.",
      };
    case "NotReadableError":
      return {
        title: "Mikrofonen kunde inte startas.",
        detail: "Stäng andra appar som använder mikrofonen och försök igen.",
        retry: true,
      };
    default:
      return {
        title: "Inspelningen kunde inte starta.",
        detail: "Försök igen eller välj Ladda upp.",
        retry: true,
      };
  }
}

function stringOptions(field: FormField): string[] {
  return Array.isArray(field.options)
    ? field.options.filter((option): option is string => typeof option === "string")
    : [];
}

function fits(field: FormField, value: DetailValue): boolean {
  if (field.type === "list") return Array.isArray(value);
  if (Array.isArray(value)) return false;
  const options = stringOptions(field);
  return field.type !== "select" || options.length === 0 || options.includes(value);
}

function defaultValue(field: FormField): DetailValue | undefined {
  if (field.default == null) return undefined;
  if (field.type !== "list") return String(field.default);
  return Array.isArray(field.default)
    ? field.default.filter((name): name is string => typeof name === "string")
    : splitNames(String(field.default));
}

/** The details that still fit the flow's fields; new fields start from their defaults. */
function fittingDetails(
  fields: FormField[],
  current: Record<string, DetailValue>,
): Record<string, DetailValue> {
  const next: Record<string, DetailValue> = {};
  for (const field of fields) {
    const value = current[field.name] ?? defaultValue(field);
    if (value !== undefined && fits(field, value)) next[field.name] = value;
  }
  return next;
}

/**
 * Whether a detail has a value Eneo takes for a required field: blank text and
 * an empty list do not, and a number (0 too) or a choice does. Eneo keeps an
 * optional detail left empty as "" or [].
 */
export function filledValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.some(filledValue);
  return value != null;
}

/** The details as the run's input_payload_json; empty ones are left out. */
export function detailsPayload(
  fields: FormField[],
  details: Record<string, DetailValue>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of fields) {
    const value = details[field.name];
    if (filledValue(value)) payload[field.name] = value;
  }
  return payload;
}

/** The browser's localStorage, or null where the page may not use it. */
export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const modeKey = (flowId: string) => `tal-till-text:mode:${flowId}`;

const lastFlowKey = (ownerId: string) => `tal-till-text:${ownerId}:last-flow`;

/** The flow this user last recorded, streamed or uploaded with in this browser. */
export function lastUsedFlow(storage: KeyValueStorage | null | undefined, ownerId: string): string | null {
  try {
    return storage?.getItem(lastFlowKey(ownerId)) ?? null;
  } catch {
    return null;
  }
}

/** The flow list with the last used flow first; the rest keep their order. */
export function withLastUsedFirst<T extends { id: string }>(flows: T[], lastId: string | null): T[] {
  const last = flows.find((flow) => flow.id === lastId);
  return last ? [last, ...flows.filter((flow) => flow !== last)] : flows;
}

/** Strömma's live text for one recording, as the session drives it. */
export interface LiveSession {
  getSnapshot(): LiveSnapshot;
  subscribe(listener: () => void): () => void;
  /** Feeds a microphone stream's audio to the live text. */
  listen(stream: MediaStream): void;
  setRecording(on: boolean): void;
  stop(): void;
  dispose(): void;
}

export interface LiveClient {
  /** Called in the start gesture, so the browser lets its audio run. */
  open(stepId: string): LiveSession;
}

export interface FlowSessionOptions {
  flowId: string;
  flowName: string;
  ownerId: string;
  /** Called on the first start, never while rendering. */
  openStore: () => RecordingStore | Promise<RecordingStore>;
  captureDeps: CaptureDeps;
  /** A recording format the browser has and the flow takes, or null. */
  pickMimeType: (accepted: string[] | undefined) => string | null;
  storage?: KeyValueStorage | null;
  /** Streams live text (Strömma), when the browser can. */
  live?: LiveClient | null;
}

export class FlowSession {
  readonly capture: RecordingCapture;
  private listeners = new Set<() => void>();
  private flowName: string;
  private contract: RunContract | null = null;
  private modes: InputMode[] = [];
  private mode: InputMode | null = null;
  private details: Record<string, DetailValue> = {};
  private explicitSpeakerLabels: boolean | null = null;
  private starting = false;
  private ready: StoredRecording | null = null;
  private file: ChosenFile | null = null;
  private invalid: string[] = [];
  private problem: Problem | null = null;
  private handlers: SessionHandlers | null = null;
  // Bumped when the page goes away: a document prepared before that is not sent. A page set up
  // again (React Strict Mode runs a cleanup between two setups) makes documents as before.
  private generation = 0;
  private probeDuration: ((file: Blob) => Promise<number | null>) | null = null;
  // Strömma: the live session, the stream it hears and what it was last told.
  private live: LiveSession | null = null;
  private liveStream: MediaStream | null = null;
  private liveRecording: boolean | null = null;
  // The browser's reason the microphone was refused, for the problem shown.
  private microphoneError: string | null = null;
  private snapshot: SessionSnapshot;

  constructor(private readonly options: FlowSessionOptions) {
    this.flowName = options.flowName;
    this.capture = new RecordingCapture(options.openStore, {
      ...options.captureDeps,
      getStream: async (constraints) => {
        try {
          return await options.captureDeps.getStream(constraints);
        } catch (error) {
          this.microphoneError = error instanceof DOMException ? error.name : null;
          throw error;
        }
      },
    });
    this.snapshot = this.derive();
    this.capture.subscribe(this.onCapture);
  }

  getSnapshot = (): SessionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The run contract, first or refreshed: the modes, and the details that still fit. */
  setContract(contract: RunContract | null): void {
    this.contract = contract;
    this.modes = availableModes(contract, {
      canRecord: this.options.pickMimeType(this.inputStep()?.accepted_mimetypes) != null,
      liveClient: this.options.live != null,
    });
    const remembered = this.read(modeKey(this.options.flowId));
    this.mode =
      this.modes.find((mode) => mode === this.mode) ??
      this.modes.find((mode) => mode === remembered) ??
      this.modes[0] ??
      null;
    this.details = fittingDetails(contract?.form_fields ?? [], this.details);
    this.emit();
  }

  /** The published flow's name, which recordings carry for recovery. */
  setFlowName(name: string): void {
    this.flowName = name;
  }

  /** Choosing only selects: nothing starts, and the choice is fixed once recording begins. */
  selectMode(mode: InputMode): void {
    if (this.snapshot.phase !== "setup" || !this.modes.includes(mode)) return;
    this.mode = mode;
    this.problem = null;
    this.write(modeKey(this.options.flowId), mode);
    this.emit();
  }

  setDetail(name: string, value: DetailValue): void {
    this.details = { ...this.details, [name]: value };
    if (filledValue(value)) this.invalid = this.invalid.filter((field) => field !== name);
    this.emit();
  }

  setSpeakerLabels(on: boolean): void {
    this.explicitSpeakerLabels = on;
    this.emit();
  }

  /** "Starta inspelning" / "Starta strömning": the microphone is asked for here. */
  async start(): Promise<void> {
    const { phase, mode } = this.snapshot;
    if (phase !== "setup" || (mode !== "spela-in" && mode !== "stromma")) return;
    const step = this.inputStep();
    const mimeType = this.options.pickMimeType(step?.accepted_mimetypes);
    if (!step || !mimeType) {
      this.problem = {
        title: "Webbläsaren kan inte spela in ljud som flödet tar emot.",
        detail: "Välj Ladda upp i stället.",
      };
      this.emit();
      return;
    }
    this.problem = null;
    this.microphoneError = null;
    this.starting = true;
    this.write(lastFlowKey(this.options.ownerId), this.options.flowId);
    // Opened in the start gesture, so the browser lets its audio run; it connects while the microphone is asked for.
    if (mode === "stromma") this.openLive(step.step_id);
    this.emit();
    try {
      await this.capture.start(
        {
          ownerId: this.options.ownerId,
          flowId: this.options.flowId,
          flowName: this.flowName,
          stepId: step.step_id,
          inputMode: mode === "stromma" ? "stream" : "record",
          mimeType,
        },
        this.limits(),
      );
    } finally {
      this.starting = false;
    }
    if (this.capture.getSnapshot().status !== "recording") {
      this.problem = microphoneProblem(this.microphoneError);
      this.closeLive();
    }
    this.emit();
  }

  /** The page's run code, which the document is handed to. */
  setHandlers(handlers: SessionHandlers): void {
    this.handlers = handlers;
  }

  /** Reads a chosen file's length, when the browser can. */
  setProbeDuration(probe: (file: Blob) => Promise<number | null>): void {
    this.probeDuration = probe;
  }

  /** Ladda upp: the file that becomes the document's input, checked first; a bad pick keeps the earlier one. */
  chooseFile(file: File): void {
    this.problem = fileProblem(file, this.inputStep());
    if (!this.problem) {
      const chosen: ChosenFile = { blob: file, filename: file.name, durationMs: null };
      this.file = chosen;
      void this.probeDuration?.(file)
        .then((durationMs) => {
          if (this.file !== chosen || durationMs == null) return;
          this.file = { ...chosen, durationMs };
          this.emit();
        })
        .catch(() => undefined);
    }
    this.emit();
  }

  /** "Ta bort": the recording leaves the device for good; the details stay. */
  async discard(): Promise<void> {
    const recording = this.ready;
    if (!recording || this.snapshot.phase !== "ready") return;
    try {
      await (await this.options.openStore()).remove(recording.id);
    } catch (error) {
      this.problem =
        error instanceof Error && error.message === IN_USE_ELSEWHERE
          ? { title: IN_USE_ELSEWHERE }
          : { title: "Inspelningen kunde inte tas bort.", detail: "Försök igen." };
      this.emit();
      return;
    }
    this.ready = null;
    this.problem = null;
    this.capture.reset();
    this.closeLive();
    this.emit();
  }

  /** An unsent recording from the list, made ready to become a document. */
  adopt(recording: StoredRecording): void {
    if (this.snapshot.phase !== "setup" && this.snapshot.phase !== "ready") return;
    this.ready = recording;
    this.problem = null;
    this.emit();
  }

  /**
   * "Skapa dokument": the required details are checked here, where they matter.
   * A send that fails keeps the recording, the file and the details.
   */
  async createDocument(): Promise<boolean> {
    const { phase, mode } = this.snapshot;
    const input: SubmitRequest["input"] =
      phase === "ready" && this.ready
        ? { kind: "recording", recording: this.ready }
        : phase === "setup" && mode === "ladda-upp" && this.file
          ? { kind: "file", ...this.file }
          : null;
    if (!input && this.modes.length > 0) return false;
    const fields = this.contract?.form_fields ?? [];
    // A run request Eneo may already have answered is sent again as it was, with its own details.
    // The store says whether there is one: an earlier send here may have kept one since.
    const generation = this.generation;
    const repeated = input?.kind === "recording" && !!(await this.stored(input.recording.id))?.submission;
    // The page went away meanwhile: its run code is gone, and nothing may be sent for it.
    if (generation !== this.generation) return false;
    this.invalid = repeated
      ? []
      : fields.filter((field) => field.required && !filledValue(this.details[field.name])).map((field) => field.name);
    this.problem = null;
    this.emit();
    if (this.invalid.length > 0 || !this.handlers) return false;
    this.write(lastFlowKey(this.options.ownerId), this.options.flowId);
    try {
      await this.handlers.submit({
        input,
        payload: detailsPayload(fields, this.details),
        speakerLabels: this.snapshot.speakerLabels ?? undefined,
      });
    } catch (error) {
      // The input and the details stay for the next try; a recording as the send left it, sealed.
      if (input?.kind === "recording") this.ready = (await this.stored(input.recording.id)) ?? this.ready;
      this.problem = submitProblem(error, this.inputStep(), input?.kind ?? null);
      if (error instanceof ApiError && error.code === "flow_run_stale_version") {
        // The newer version's contract decides which details still fit.
        await this.handlers.reloadFlow?.().catch(() => undefined);
      }
      this.emit();
      return false;
    }
    // Eneo has the run: a sent recording is no longer on the device.
    if (input?.kind === "recording") {
      this.ready = null;
      this.capture.reset();
      this.closeLive();
    }
    if (input?.kind === "file") this.file = null;
    this.emit();
    return true;
  }

  /**
   * "Fortsätt spela in" on a recording a reload cut off: the recorder takes it
   * over and records on in a new part, so the meeting still becomes one run.
   */
  async continueCutOff(recording: StoredRecording): Promise<void> {
    if (this.snapshot.phase !== "setup") return;
    await this.recordOn(recording, (id, limits) => this.capture.adopt(id, limits));
  }

  /** "Fortsätt spela in" after Stoppa: a new part of the same recording, until a send of it has begun. */
  async continueStopped(): Promise<void> {
    const recording = this.ready;
    if (this.snapshot.phase !== "ready" || !recording) return;
    await this.recordOn(recording, (id, limits) => this.capture.continueStopped(id, limits));
  }

  togglePause(): void {
    this.capture.togglePause();
  }

  /** Stoppa ends capture and leads to the ready state; it never discards. */
  async stop(): Promise<void> {
    await this.capture.stop();
  }

  /** "Fortsätt spela in" after the microphone went away: a new part of the same recording. */
  async continueRecording(): Promise<void> {
    this.microphoneError = null;
    await this.capture.continueRecording();
    if (this.capture.getSnapshot().status === "interrupted") {
      this.problem = microphoneProblem(this.microphoneError);
      this.emit();
    }
  }

  /** The page goes away: what was recorded stays on the device for recovery. */
  dispose(): void {
    this.generation += 1;
    this.capture.dispose();
    this.closeLive();
  }

  private async stored(recordingId: string): Promise<StoredRecording | null> {
    try {
      return await (await this.options.openStore()).get(recordingId);
    } catch {
      return null;
    }
  }

  private inputStep() {
    return selectRuntimeInputStep(this.contract);
  }

  /** The flow's limits for the audio step: bytes per file and files per run. */
  private limits(): CaptureLimits {
    const step = this.inputStep();
    return { maxBytes: step?.max_file_size_bytes, maxFiles: step?.max_files };
  }

  /** Records on in a new part of a stored recording, in the mode it was made in; a refusal says why. */
  private async recordOn(
    recording: StoredRecording,
    takeOver: (recordingId: string, limits: CaptureLimits) => Promise<void>,
  ) {
    const live = recording.inputMode === "stream" && this.modes.includes("stromma");
    this.mode = live ? "stromma" : "spela-in";
    this.problem = null;
    if (live) this.openLive(recording.stepId);
    this.emit();
    await takeOver(recording.id, this.limits());
    const { status, error } = this.capture.getSnapshot();
    if (status === "recording") return;
    this.closeLive();
    if (error) this.problem = { title: error };
    this.emit();
  }

  private openLive(stepId: string) {
    this.closeLive();
    this.live = this.options.live?.open(stepId) ?? null;
  }

  private closeLive() {
    this.live?.dispose();
    this.live = null;
    this.liveStream = null;
    this.liveRecording = null;
  }

  /** Live text follows the recorder: its microphone, pauses and the stop; its own failures never reach back. */
  private followLive() {
    const live = this.live;
    if (!live) return;
    const { status, stream } = this.capture.getSnapshot();
    if (stream && stream !== this.liveStream) {
      this.liveStream = stream;
      live.listen(stream);
    }
    if (status === "recording" || status === "paused" || status === "interrupted") {
      const recording = status === "recording";
      if (recording !== this.liveRecording) {
        this.liveRecording = recording;
        live.setRecording(recording);
      }
    } else if (status === "stopped" && this.liveStream !== null) {
      this.liveStream = null;
      this.liveRecording = false;
      live.stop();
    }
  }

  private onCapture = () => {
    this.followLive();
    const { status, recording, error } = this.capture.getSnapshot();
    // Each stop gives the whole recording again, also after "Fortsätt spela in".
    if (status === "stopped" && recording && this.ready !== recording) {
      this.ready = recording;
      // A stop at the flow's size limit says so; what was recorded is kept.
      if (error) this.problem = { title: error };
    }
    if (status === "recording") this.problem = null;
    this.emit();
  };

  private derive(): SessionSnapshot {
    const capture = this.capture.getSnapshot();
    const capturing =
      capture.status === "recording" || capture.status === "paused" || capture.status === "interrupted";
    return {
      modes: this.modes,
      mode: this.mode,
      phase: capturing
        ? (capture.status as "recording" | "paused" | "interrupted")
        : this.starting
          ? "starting"
          : this.ready
            ? "ready"
            : "setup",
      details: this.details,
      invalid: this.invalid,
      speakerLabels: speakerLabelsFor(
        this.contract?.transcription?.speaker_labels,
        this.mode,
        this.explicitSpeakerLabels,
      ),
      recording: capturing ? capture.recording : this.ready,
      file: this.file,
      live: this.live,
      problem: this.problem,
    };
  }

  private emit() {
    const next = this.derive();
    const changed = (Object.keys(next) as (keyof SessionSnapshot)[]).some(
      (key) => next[key] !== this.snapshot[key],
    );
    if (!changed) return;
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }

  private read(key: string): string | null {
    try {
      return this.options.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private write(key: string, value: string) {
    try {
      this.options.storage?.setItem(key, value);
    } catch {
      // Blocked storage: the choice is only a convenience.
    }
  }
}
