/** What the recording states say: the tab title, the bar's line, the announcements. */

import type { FormField } from "./api";
import type { DetailValue, Problem, SessionPhase } from "./flow-session";
import { formatClock } from "./format";
import type { LiveStatus } from "./live-transcriber";
import type { CaptureStatus } from "./recording-session";
import type { DeviceRefusal } from "./recording-store";

const APP = "Tal till text";
/** The recording bar's fixed line under Pausa and Stoppa. */
export const STOP_LINE = "Stoppa avslutar inspelningen. Du väljer sedan att skapa dokumentet.";
const MINUTE = 60_000;

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
    // Stopped, not yet a document: "Klart" is the finished document's.
    case "ready":
      return `Inte skickad · ${APP}`;
    default:
      return flowName ? `${flowName} · ${APP}` : APP;
  }
}

/**
 * What the recording bar says now: warnings of what can lose the meeting (no sound, no microphone, no room on
 * the device), shown as alerts above the controls, and calmer notes in its line.
 */
export function recordingNotices({
  phase,
  silent,
  lowSpace,
  persistent,
  refused,
  remainingMs,
  muted,
  wakeLock,
}: {
  phase: SessionPhase;
  silent: boolean;
  lowSpace: boolean;
  persistent: boolean;
  refused: DeviceRefusal | null;
  /** Recording time the flow still takes; null when it sets no end. */
  remainingMs: number | null;
  /** The microphone's track is muted for now (a headset changing its route). */
  muted: boolean;
  wakeLock: boolean;
}): { warnings: Problem[]; notes: string[] } {
  const warnings: Problem[] = [];
  const notes: string[] = [];
  if (phase === "interrupted") {
    warnings.push({ title: "Inspelningen pausades när mikrofonen försvann.", detail: "Det som spelats in finns kvar." });
  }
  if (phase === "recording" && muted) {
    warnings.push({ title: "Mikrofonen är tillfälligt borta.", detail: "Inspelningen fortsätter av sig själv när den är tillbaka." });
  }
  if ((phase === "recording" || phase === "paused") && remainingMs !== null && remainingMs <= 15 * MINUTE) {
    // A step, not a count: the line changes twice, and never ticks.
    const left = remainingMs <= 5 * MINUTE ? 5 : 15;
    notes.push(`Mindre än ${left} minuter kvar till flödets maxlängd. Då stoppas inspelningen och det som spelats in sparas.`);
  }
  if (phase === "recording" && silent) {
    warnings.push({ title: "Vi hör inget från mikrofonen.", detail: "Kontrollera att den inte är avstängd." });
  }
  if (lowSpace) {
    warnings.push({ title: "Det finns lite lagringsutrymme kvar på enheten.", detail: "Frigör utrymme om du ska spela in länge." });
  }
  if (refused) {
    // Nothing stops, and Spara som fil after Stoppa keeps what only this tab has.
    const cause = refused === "full" ? "Enheten har inte plats för att spara mer." : "Enheten kan inte spara mer av inspelningen.";
    warnings.push({ title: cause, detail: "Inspelningen fortsätter, men välj Spara som fil när du stoppar." });
  } else if (!persistent) {
    notes.push("Inspelningen sparas bara i den här fliken. Stäng inte fliken innan dokumentet är skapat.");
  }
  if (!wakeLock) notes.push("Låt skärmen vara tänd under inspelningen.");
  return { warnings, notes };
}

/** Said once when the recording's state changes; never the timer. */
export function recordingAnnouncement(phase: SessionPhase): string {
  switch (phase) {
    case "recording":
      return "Spelar in.";
    case "paused":
      return "Inspelningen är pausad.";
    // The recording bar's warning says it; saying it here too would read it twice.
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
 * What "Lämna sidan?" says. A running recording stops: it does not go on in
 * the background. The recording is promised back among unsent recordings
 * only when the device keeps it; otherwise leaving loses it, and the way to
 * keep it is "Spara som fil" (after Stoppa, while recording).
 */
export function leaveWarning(persistent: boolean | null, phase: SessionPhase, sending = false): string {
  if (sending && phase === "setup") return "Sändningen avbryts, och filen behöver väljas igen.";
  const capturing = phase === "recording" || phase === "paused" || phase === "interrupted";
  const stops = sending ? "Sändningen avbryts. " : capturing ? "Inspelningen stoppas. " : "";
  if (persistent) return `${stops}Det som spelats in finns kvar bland osända inspelningar.`;
  const lost = `${stops}${capturing ? "Den" : "Inspelningen"} finns bara i den här fliken och försvinner när du lämnar sidan.`;
  return phase === "ready"
    ? `${lost} Välj Spara som fil först om du vill behålla den.`
    : `${lost} Stoppa och välj Spara som fil först om du vill behålla den.`;
}

/**
 * The filled details as label and text, in the form's order: the form being filled in, or the payload a run
 * was started with (only the flow's own fields; anything else in it is not a detail).
 */
export function detailRows(fields: FormField[], values: Record<string, unknown>): { label: string; text: string }[] {
  return fields.flatMap((field) => {
    const value = values[field.name];
    const text = Array.isArray(value)
      ? value.map(String).filter((item) => item.trim()).join(", ")
      : typeof value === "string"
        ? value.trim()
        : typeof value === "number"
          ? String(value)
          : "";
    return text ? [{ label: field.label || field.name, text }] : [];
  });
}

/** "Deltagare: Anna Berg, Erik Lund · Mötets namn: KS", for the collapsed details. */
export function detailsSummary(fields: FormField[], details: Record<string, DetailValue | unknown>): string {
  const rows = detailRows(fields, details);
  return rows.length > 0 ? rows.map(({ label, text }) => `${label}: ${text}`).join(" · ") : "Inga uppgifter ifyllda";
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
