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
import { clearDraft, readDraft, writeDraft, type DraftStorage } from "./drafts";
import { errorAdvice, friendlyError } from "./errors";
import { splitNames } from "./participants";
import { RecordingCapture, type CaptureDeps, type CaptureLimits } from "./recording-session";
import { ALREADY_SENT, IN_USE_ELSEWHERE, type RecordingStore, type StoredRecording } from "./recording-store";
import { formatBytes, formatDuration } from "./format";
import type { LivePiece, LiveSnapshot } from "./live-transcriber";
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
  /** Eneo already has a run for the recording: show the earlier runs, and offer deleting the copy. */
  sent?: boolean;
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
  /** Reads this user's earlier runs of the flow again. */
  refreshEarlierRuns?: () => void;
}

// Every type Eneo takes as a flow's file input: the name people know it by and the
// extensions it comes as. The rows' order is the order the names are said in.
const FILE_TYPES: [name: string, mime: string, ...extensions: string[]][] = [
  ["Word", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["PDF", "application/pdf", "pdf"],
  ["PowerPoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
  ["Excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  ["Excel", "application/vnd.ms-excel", "xls"],
  ["CSV", "text/csv", "csv"],
  ["CSV", "application/csv", "csv"],
  ["text", "text/plain", "txt"],
  ["Markdown", "text/markdown", "md", "markdown"],
  ["Markdown", "text/x-markdown", "md", "markdown"],
  ["JSON", "application/json", "json"],
  ["XML", "text/xml", "xml"],
  ["XML", "application/xml", "xml"],
  ["MP3", "audio/mpeg", "mp3"],
  ["MP3", "audio/mp3", "mp3"],
  ["WAV", "audio/wav", "wav"],
  ["WAV", "audio/x-wav", "wav"],
  ["WAV", "audio/wave", "wav"],
  ["WAV", "audio/vnd.wave", "wav"],
  ["M4A", "audio/mp4", "m4a", "mp4"],
  ["M4A", "audio/x-m4a", "m4a"],
  ["M4A", "audio/m4a", "m4a"],
  ["M4A", "video/mp4", "mp4"],
  ["AAC", "audio/aac", "aac"],
  ["WebM", "audio/webm", "webm", "weba"],
  ["WebM", "video/webm", "webm"],
  ["Ogg", "audio/ogg", "ogg", "oga"],
  ["FLAC", "audio/flac", "flac"],
  ["FLAC", "audio/x-flac", "flac"],
  ["PNG", "image/png", "png"],
  ["JPEG", "image/jpeg", "jpg", "jpeg"],
  ["WebP", "image/webp", "webp"],
  ["AVIF", "image/avif", "avif"],
  ["HEIC", "image/heic", "heic"],
  ["HEIC", "image/heif", "heif"],
];

/** The row for a type the table knows, else a guess at its extension from the subtype ("audio/x-amr" is ".amr"). */
function fileType(mime: string): { name: string; order: number; extensions: string[] } | null {
  const base = baseMimetype(mime);
  const order = FILE_TYPES.findIndex((row) => row[1] === base);
  if (order >= 0) {
    const [name, , ...extensions] = FILE_TYPES[order];
    return { name, order, extensions: extensions.map((extension) => `.${extension}`) };
  }
  // ponytail: a subtype that is no plain word (a "vnd." name, a wildcard) is left unnamed; add a row when Eneo takes one.
  const extension = base.split("/")[1]?.replace(/^x-/, "") ?? "";
  if (!/^[a-z0-9]+$/.test(extension)) return null;
  return { name: `.${extension}`, order: FILE_TYPES.length, extensions: [`.${extension}`] };
}

/** "Word, PDF och Markdown": the flow's accepted types in plain words, each named once. */
export function acceptedFormats(mimetypes: string[] | undefined): string | null {
  const known = (mimetypes ?? []).flatMap((mime) => fileType(mime) ?? []);
  const names = [...new Set(known.sort((a, b) => a.order - b.order).map((type) => type.name))];
  if (names.length === 0) return null;
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} och ${names[names.length - 1]}`;
}

/** The file chooser's `accept`: each type and its extensions, since a dialog may not know a type's extension. */
export function fileAccept(mimetypes: string[] | undefined): string | undefined {
  const accept = [...new Set((mimetypes ?? []).flatMap((mime) => [mime, ...(fileType(mime)?.extensions ?? [])]))];
  return accept.length > 0 ? accept.join(",") : undefined;
}

/** The type a file is sent as: the browser's when the flow takes it, else the flow's type for the file's extension. */
function uploadType(file: { name: string; type: string }, accepted: string[] | undefined): string {
  if (file.type && isMimeAllowed(file.type, accepted)) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const matches = FILE_TYPES.filter(([, , ...extensions]) => extensions.includes(extension)).map((row) => row[1]);
  return matches.find((mime) => isMimeAllowed(mime, accepted)) ?? (file.type || matches[0] || "");
}

function oversized(maxBytes: number, inputFormat: string | undefined): Problem {
  return {
    title: `Filen är större än flödet tar emot (högst ${formatBytes(maxBytes)}).`,
    detail: inputFormat === "audio" ? "Välj en kortare inspelning eller dela upp den." : "Välj en mindre fil eller dela upp den.",
  };
}

/** Known only once the browser has read the file's length; Eneo refuses it too, but only after the upload. */
function tooLong(maxSeconds: number): Problem {
  return {
    // Kept on one line like a size: "5 h", never "5" and "h" apart.
    title: `Filen är längre än flödet tar emot (högst ${formatDuration(maxSeconds * 1000).replace(/ /g, "\u00a0")}).`,
    detail: "Välj en kortare fil eller dela upp den.",
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
  const type = uploadType(file, accepted);
  if (type && !isMimeAllowed(type, accepted)) return unsupported(accepted);
  if (file.size === 0) return { title: "Filen är tom.", detail: "Välj en annan fil." };
  if (step?.max_file_size_bytes && file.size > step.max_file_size_bytes) return oversized(step.max_file_size_bytes, step.input_format);
  return null;
}

/** A failed send in the product's words, with the next step. */
export function submitProblem(
  error: unknown,
  step: RunContractStepInput | null,
  inputKind: "recording" | "file" | null,
): Problem {
  if (error instanceof Error && error.message === ALREADY_SENT) return { title: ALREADY_SENT, sent: true };
  if (error instanceof ApiError) {
    if (error.code === "flow_run_stale_version") {
      return { title: "Flödet har uppdaterats sedan sidan öppnades. Kontrollera uppgifterna och välj Skapa dokument igen." };
    }
    const kept =
      inputKind === "recording" ? "Inspelningen finns kvar. Spara den som fil om du vill behålla den." : "Välj ett annat flöde.";
    if (error.status === 404 || error.code === "flow_not_published") {
      return { title: "Flödet är inte längre tillgängligt.", detail: kept, back: true };
    }
    const advice = errorAdvice(error);
    if (advice.ownerMustFix) return { title: advice.message, detail: kept, back: true };
    if ((error.status === 413 || error.code === "file_too_large") && step?.max_file_size_bytes) {
      return oversized(step.max_file_size_bytes, step.input_format);
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
  /** Its length is still being read; it cannot be sent yet. */
  fileChecking: boolean;
  /** Strömma's live text for the recording, when there is one. */
  live: LiveSession | null;
  /** Strömma's final text may still let the run use the streamed text: Skapa dokument waits for it, briefly. */
  finishing: boolean;
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

/** The flow's own default in every mode, Strömma included, until the person chooses. */
export function speakerLabelsFor(
  option: FlowTranscriptionContract["speaker_labels"] | null | undefined,
  explicit: boolean | null,
): boolean | null {
  if (!option?.selectable) return null;
  return explicit ?? option.default;
}

/** Whether the run labels speakers: the switch where the flow offers one, else whether the flow requires it. */
export function labelsSpeakers(
  option: FlowTranscriptionContract["speaker_labels"] | null | undefined,
  choice: boolean | null,
): boolean {
  return choice ?? Boolean(option?.required);
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
  /**
   * Called in the start gesture, so the browser lets its audio run. `recordingId` names the recording the session
   * hears from its start, so Eneo can keep the session's text for the run; without it the text is a preview only.
   * `earlier` is the draft to go on from.
   */
  open(stepId: string, recordingId?: string, earlier?: LivePiece[]): LiveSession;
}

// How long Skapa dokument waits for Strömma's final text and its keeping: measured at 4 s on an idle machine and
// over 10 s under load, against minutes for transcribing the audio again.
const FINISHING_WAIT_MS = 20_000;

/** Live text that could not be set up at all, as the sheet shows it; a continued recording keeps its earlier draft. */
const unavailableLive = (earlier: LivePiece[] = []): LiveSession => {
  const snapshot: LiveSnapshot = { status: "unavailable", pieces: earlier, pending: "", started: false, complete: false };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    listen: () => undefined,
    setRecording: () => undefined,
    stop: () => undefined,
    dispose: () => undefined,
  };
};

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
  /** Where the details typed so far are kept for this person until the document is made. */
  drafts?: DraftStorage | null;
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
  // The file shown: the latest pick, while its length is read, else the last one that fitted (`accepted`).
  private file: ChosenFile | null = null;
  private accepted: ChosenFile | null = null;
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
  // Whether live text names the recording, so its final text may bring a transcript, and whether that is awaited.
  private liveNamed = false;
  private finishing = false;
  private finishingTimer: ReturnType<typeof setTimeout> | null = null;
  // A transcript being kept with its recording, under the recording's lease: a send waits for it.
  private keeping: Promise<void> | null = null;
  // The browser's reason the microphone was refused, for the problem shown.
  private microphoneError: string | null = null;
  private snapshot: SessionSnapshot;

  constructor(private readonly options: FlowSessionOptions) {
    this.flowName = options.flowName;
    // What this person typed before a reload (a lost login, a tab put to sleep); the contract decides what fits.
    this.details = readDraft<Record<string, DetailValue>>(options.drafts, options.ownerId, this.draftName()) ?? {};
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
    // No contract yet (still loading): nothing to fit, and a restored draft waits for it.
    if (contract) this.details = fittingDetails(contract.form_fields ?? [], this.details);
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
    writeDraft(this.options.drafts, this.options.ownerId, this.draftName(), this.details);
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
    // Named ahead, so live text names the recording to Eneo from its first sample.
    const recordingId = crypto.randomUUID();
    try {
      // Opened in the start gesture, so the browser lets its audio run; it connects while the microphone is asked for.
      if (mode === "stromma") this.openLive(step.step_id, { recordingId });
      this.emit();
      await this.capture.start(
        {
          id: recordingId,
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

  /**
   * Ladda upp: the file that becomes the document's input, checked first; a bad pick keeps the earlier one.
   * Its length is checked once the browser has read it; too long, it gives back the last file that fitted.
   */
  chooseFile(file: File): void {
    this.problem = fileProblem(file, this.inputStep());
    if (!this.problem) {
      const type = uploadType(file, this.inputStep()?.accepted_mimetypes);
      const blob = type === file.type ? file : file.slice(0, file.size, type);
      const chosen: ChosenFile = { blob, filename: file.name, durationMs: null };
      this.file = chosen;
      const check = this.probeDuration?.(file)
        .then((durationMs) => {
          if (this.file !== chosen) return;
          const maxSeconds = this.inputStep()?.max_duration_seconds;
          if (durationMs != null && maxSeconds && durationMs > maxSeconds * 1000) {
            this.file = this.accepted;
            this.problem = tooLong(maxSeconds);
          } else {
            // A length the browser cannot tell is Eneo's to judge.
            this.file = this.accepted = durationMs == null ? chosen : { ...chosen, durationMs };
          }
          this.emit();
        })
        .catch(() => undefined);
      if (!check) this.accepted = chosen;
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
    // The button says it waits; a press meanwhile sends nothing and leaves nothing to send later.
    if (this.finishing) return false;
    const { phase, mode, fileChecking } = this.snapshot;
    // Ladda upp: a file whose length is still being read is not sent; the action says it is checking.
    if (phase === "setup" && mode === "ladda-upp" && fileChecking) return false;
    const input: SubmitRequest["input"] =
      phase === "ready" && this.ready
        ? { kind: "recording", recording: this.ready }
        : phase === "setup" && mode === "ladda-upp" && this.file
          ? { kind: "file", ...this.file }
          : null;
    // Without audio or a file, only Ladda upp in setup sends, and only for a flow whose file is optional
    // (Eneo reads required: false): a send from the unsent list while a recording starts never goes empty.
    const withoutFile = phase === "setup" && mode === "ladda-upp" && this.inputStep()?.required === false;
    if (!input && this.modes.length > 0 && !withoutFile) return false;
    const fields = this.contract?.form_fields ?? [];
    // A run request Eneo may already have answered is sent again as it was, with its own details.
    // The store says whether there is one: an earlier send here may have kept one since.
    const generation = this.generation;
    // A transcript still being kept holds the recording's lease: the send waits for that local write.
    await this.keeping;
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
      // The run Eneo has is among the earlier runs, which may have been read before it existed.
      if (this.problem.sent) this.handlers.refreshEarlierRuns?.();
      this.emit();
      return false;
    }
    // Eneo has the run: a sent recording is no longer on the device.
    if (input?.kind === "recording") {
      this.ready = null;
      this.capture.reset();
      this.closeLive();
    }
    if (input?.kind === "file") this.file = this.accepted = null;
    clearDraft(this.options.drafts, this.options.ownerId, this.draftName());
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

  private draftName() {
    return `flow:${this.options.flowId}`;
  }

  private inputStep() {
    return selectRuntimeInputStep(this.contract);
  }

  /** The flow's limits for the audio step: bytes and time per file, and files per run. */
  private limits(): CaptureLimits {
    const step = this.inputStep();
    const seconds = step?.max_duration_seconds;
    return { maxBytes: step?.max_file_size_bytes, maxDurationMs: seconds ? seconds * 1000 : undefined, maxFiles: step?.max_files };
  }

  /**
   * Records on in a new part of a stored recording, in the mode it was made in; a refusal says why. Its live text
   * hears only the new part, so it names no recording: a preview only.
   */
  private async recordOn(
    recording: StoredRecording,
    takeOver: (recordingId: string, limits: CaptureLimits) => Promise<void>,
  ) {
    const live = recording.inputMode === "stream" && this.modes.includes("stromma");
    this.mode = live ? "stromma" : "spela-in";
    this.problem = null;
    // After Stoppa, the live text so far goes on above the new part's. Closed first, so words still arriving
    // after Stoppa are part of it.
    const earlier = this.live;
    this.closeLive();
    if (live) this.openLive(recording.stepId, { earlier: earlier?.getSnapshot().pieces });
    this.emit();
    await takeOver(recording.id, this.limits());
    const { status, error } = this.capture.getSnapshot();
    if (status === "recording") return;
    this.closeLive();
    // Refused: the draft stays with the stopped recording.
    this.live = earlier;
    if (error) this.problem = { title: error };
    this.emit();
  }

  private openLive(stepId: string, { recordingId, earlier }: { recordingId?: string; earlier?: LivePiece[] } = {}) {
    this.closeLive();
    this.liveNamed = recordingId !== undefined;
    try {
      this.live = this.options.live?.open(stepId, recordingId, earlier) ?? null;
    } catch {
      // Live text could not even be set up: the recording goes on, and the sheet says so.
      this.live = unavailableLive(earlier);
    }
  }

  private closeLive() {
    this.live?.dispose();
    this.live = null;
    this.liveStream = null;
    this.liveRecording = null;
    this.liveNamed = false;
    this.clearFinishing();
  }

  /** Live text follows the recorder: its microphone, pauses and the stop; its own failures never reach back. */
  private followLive() {
    const live = this.live;
    if (!live) return;
    const { status, stream, recording, stopping } = this.capture.getSnapshot();
    if (stopping || status === "stopped") {
      // Stored in more than one part (a new part at the flow's limit), it keeps no transcript: nothing to wait for.
      if (status === "stopped" && recording && recording.parts.length > 1) this.clearFinishing();
      // With the recorder's own stop, before the recording is stored: live text hears what the file has.
      if (this.liveStream === null) return;
      this.liveStream = null;
      this.liveRecording = false;
      if (recording && this.liveNamed) this.stopKeepingTranscript(live, recording.id);
      else live.stop();
      return;
    }
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
    }
  }

  /**
   * Stops live text that named the recording. A clean session's stored transcript goes with the recording, so its
   * run need not transcribe the audio again; while live text awaits it, and until it is kept, Skapa dokument waits.
   */
  private stopKeepingTranscript(live: LiveSession, recordingId: string) {
    let kept = false;
    const done = () => {
      if (this.live !== live || !this.finishing) return;
      this.clearFinishing();
      this.emit();
    };
    const unsubscribe = live.subscribe(() => {
      const { status, transcriptId, finishing } = live.getSnapshot();
      if (transcriptId && !kept) {
        kept = true;
        const keeping: Promise<void> = Promise.resolve(this.options.openStore())
          .then((store) => store.keepLiveTranscript(recordingId, transcriptId))
          .catch(() => undefined)
          .finally(() => {
            if (this.keeping === keeping) this.keeping = null;
            done();
          });
        this.keeping = keeping;
      } else if (!kept && !finishing) {
        done();
      }
      if (kept || status === "ended") unsubscribe();
    });
    live.stop();
    if (!live.getSnapshot().finishing) return;
    // The whole wait, the text and its keeping, is bounded here; after it the text is still kept if it comes.
    this.finishing = true;
    this.finishingTimer = setTimeout(done, FINISHING_WAIT_MS);
  }

  private clearFinishing() {
    if (this.finishingTimer !== null) clearTimeout(this.finishingTimer);
    this.finishingTimer = null;
    this.finishing = false;
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
      speakerLabels: speakerLabelsFor(this.contract?.transcription?.speaker_labels, this.explicitSpeakerLabels),
      recording: capturing ? capture.recording : this.ready,
      file: this.file,
      // The latest pick while its length is read: the file shown is not yet the last one that fitted.
      fileChecking: this.file !== null && this.file !== this.accepted,
      live: this.live,
      finishing: this.finishing,
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
