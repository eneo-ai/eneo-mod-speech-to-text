/** What the recording states say: the tab title, the bar's line, the announcements. */

import type { FormField } from "./api";
import type { DetailValue, SessionPhase } from "./flow-session";
import { formatClock } from "./format";
import type { LiveStatus } from "./live-transcriber";
import type { CaptureStatus } from "./recording-session";

const APP = "Tal till text";
const STOP_LINE = "Stoppa avslutar inspelningen. Du väljer sedan att skapa dokumentet.";
const INTERRUPTED = "Inspelningen pausades när mikrofonen försvann. Det som spelats in finns kvar.";

/** Silence after `afterMs` below `floor`; sound, or a reset, starts the count over. */
export class SilenceWatch {
  private quietSince: number | null = null;

  constructor(
    private readonly afterMs = 15_000,
    // About −55 dBFS on the level scale: room tone, not speech.
    private readonly floor = 0.1,
  ) {}

  update(level: number, now: number): boolean {
    if (level >= this.floor) {
      this.quietSince = null;
      return false;
    }
    this.quietSince ??= now;
    return now - this.quietSince >= this.afterMs;
  }

  reset(): void {
    this.quietSince = null;
  }
}

/** The tab title, so a user in another tab still sees that recording runs. */
export function pageTitle(phase: SessionPhase, elapsedMs: number, flowName: string): string {
  switch (phase) {
    case "recording":
      return `Spelar in ${formatClock(elapsedMs)} · ${APP}`;
    case "paused":
    case "interrupted":
      return `Pausad · ${APP}`;
    case "ready":
      return `Klart · ${APP}`;
    default:
      return flowName ? `${flowName} · ${APP}` : APP;
  }
}

/** The recording bar's line: what matters now, then what Stoppa does. */
export function recordingNotices({
  phase,
  silent,
  lowSpace,
  persistent,
  wakeLock,
}: {
  phase: SessionPhase;
  silent: boolean;
  lowSpace: boolean;
  persistent: boolean;
  wakeLock: boolean;
}): string[] {
  const notices: string[] = [];
  if (phase === "interrupted") notices.push(INTERRUPTED);
  if (phase === "recording" && silent) notices.push("Vi hör inget ljud. Kontrollera att mikrofonen är på.");
  if (lowSpace) {
    notices.push("Det finns lite lagringsutrymme kvar på enheten. Frigör utrymme om du ska spela in länge.");
  }
  if (!persistent) {
    notices.push("Inspelningen sparas bara i den här fliken. Stäng inte fliken innan dokumentet är skapat.");
  }
  if (!wakeLock) notices.push("Låt skärmen vara tänd under inspelningen.");
  return [...notices, STOP_LINE];
}

/** Said once when the recording's state changes; never the timer. */
export function recordingAnnouncement(phase: SessionPhase): string {
  switch (phase) {
    case "recording":
      return "Spelar in.";
    case "paused":
      return "Inspelningen är pausad.";
    case "interrupted":
      return INTERRUPTED;
    default:
      return "";
  }
}

/** "Deltagare: Anna Berg, Erik Lund · Mötets namn: KS", for the collapsed details. */
export function detailsSummary(fields: FormField[], details: Record<string, DetailValue>): string {
  const parts = fields.flatMap((field) => {
    const value = details[field.name];
    const text = Array.isArray(value) ? value.join(", ") : (value ?? "").trim();
    return text ? [`${field.label || field.name}: ${text}`] : [];
  });
  return parts.length > 0 ? parts.join(" · ") : "Inga uppgifter ifyllda";
}

/** The reader is at the end of the draft (a line's height short still counts): new text may scroll it. */
export function atBottom({
  scrollTop,
  clientHeight,
  scrollHeight,
}: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= 24;
}

/**
 * What live text is doing, apart from the recording. Said only while the
 * recorder confirms that it records, so a delayed draft never reads as a
 * stopped microphone and "Inspelningen fortsätter" is never a guess.
 */
export function liveStatusLine(live: LiveStatus, started: boolean, recorder: CaptureStatus): string | null {
  if (recorder !== "recording") return null;
  switch (live) {
    case "reconnecting":
      return started
        ? "Livetexten pausades. Inspelningen fortsätter."
        : "Livetexten kan inte starta just nu. Inspelningen fortsätter.";
    case "unavailable":
      return "Livetexten kunde inte starta. Inspelningen fortsätter, och texten skapas när du stoppar.";
    case "stopped":
      return "Livetexten stannade. Inspelningen fortsätter, och texten skapas när du stoppar.";
    default:
      return null;
  }
}
