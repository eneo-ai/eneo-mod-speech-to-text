/** What the recording states say: the tab title, the bar's line, the announcements. */

import type { FormField } from "./api";
import type { DetailValue, SessionPhase } from "./flow-session";
import { formatClock } from "./format";
import type { LiveStatus } from "./live-transcriber";
import type { CaptureStatus } from "./recording-session";
import type { DeviceRefusal } from "./recording-store";

const APP = "Tal till text";
const STOP_LINE = "Stoppa avslutar inspelningen. Du väljer sedan att skapa dokumentet.";
const INTERRUPTED = "Inspelningen pausades när mikrofonen försvann. Det som spelats in finns kvar.";

/**
 * Digital silence for `afterMs`: every read's loudest sample below `floor`, which only a muted or wrong input
 * gives. A quiet room is not that: a real microphone's room tone stays far above it. Sound, or a reset, starts
 * the count over.
 */
export class SilenceWatch {
  private quietSince: number | null = null;

  constructor(
    private readonly afterMs = 15_000,
    // Two steps of 16-bit audio (about −84 dBFS).
    private readonly floor = 2 / 32_768,
  ) {}

  update(peak: number, now: number): boolean {
    if (peak >= this.floor) {
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
  refused,
  wakeLock,
}: {
  phase: SessionPhase;
  silent: boolean;
  lowSpace: boolean;
  persistent: boolean;
  refused: DeviceRefusal | null;
  wakeLock: boolean;
}): string[] {
  const notices: string[] = [];
  if (phase === "interrupted") notices.push(INTERRUPTED);
  if (phase === "recording" && silent) notices.push("Vi hör inget från mikrofonen. Kontrollera att den inte är avstängd.");
  if (lowSpace) {
    notices.push("Det finns lite lagringsutrymme kvar på enheten. Frigör utrymme om du ska spela in länge.");
  }
  if (refused) {
    // Once, calmly: nothing stops, and Spara som fil after Stoppa keeps what only this tab has.
    const cause = refused === "full" ? "Enheten har inte plats för att spara mer." : "Enheten kan inte spara mer av inspelningen.";
    notices.push(`${cause} Inspelningen fortsätter, men välj Spara som fil när du stoppar.`);
  } else if (!persistent) {
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
    // The recording bar's line says it; saying it here too would read it twice.
    default:
      return "";
  }
}

/**
 * The details folded into one line on a phone: a required detail the send
 * found missing unfolds them, and they stay unfolded while it is filled in,
 * until the user folds them again.
 */
export function keepDetailsOpen(open: boolean, invalid: readonly string[]): boolean {
  return open || invalid.length > 0;
}

/** What "Lämna sidan?" says when only typed work is at stake, which the browser could not keep. */
export const UNSTORED_LEAVE = "Det du har skrivit kunde inte sparas i webbläsaren och försvinner om du lämnar sidan.";

/**
 * What "Lämna sidan?" says. The recording is promised back among unsent
 * recordings only when the device keeps it; otherwise leaving loses it, and
 * the way to keep it is "Spara som fil" (after Stoppa, while recording).
 */
export function leaveWarning(persistent: boolean | null, phase: SessionPhase, sending = false): string {
  if (sending && phase === "setup") return "Sändningen avbryts, och filen behöver väljas igen.";
  const stops = sending ? "Sändningen avbryts. " : "";
  if (persistent) return `${stops}Det som spelats in finns kvar bland osända inspelningar.`;
  const lost = `${stops}Inspelningen finns bara i den här fliken och försvinner när du lämnar sidan.`;
  return phase === "ready"
    ? `${lost} Välj Spara som fil först om du vill behålla den.`
    : `${lost} Stoppa och välj Spara som fil först om du vill behålla den.`;
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
