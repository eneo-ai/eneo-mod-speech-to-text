/**
 * The recording page's words and small rules: tab titles, notices, announcements, the leave warning, the details
 * summary, the live text's status line and when its sheet follows new text.
 */

import type { FormField } from "./api";
import type { Problem, SessionPhase } from "./flow-session";
import { formatClock, formatDuration } from "./format";
import type { LiveStatus } from "./live-transcriber";
import { TIME_LEFT_NOTE_MS, TIME_LEFT_WARNING_MS, type CaptureStatus } from "./recording-session";
import type { DeviceRefusal } from "./recording-store";
import { documentTitle } from "./product";

/** The recording bar's fixed line under Pausa and Stoppa, by what the flow makes. */
export const stopLine = (makesText: boolean) =>
  `Stoppa avslutar inspelningen. Sedan kan du skapa ${makesText ? "texten" : "dokumentet"}.`;

const SILENT_AFTER_MS = 15_000;
// Two steps of 16-bit audio (about −84 dBFS).
const SILENT_FLOOR = 2 / 32_768;

/**
 * Digital silence for 15 s: every read's loudest sample below two steps of 16-bit audio, which only a muted or wrong
 * input gives. A quiet room is not that: a real microphone's room tone stays far above it. Sound, or a reset, starts
 * the count over.
 */
export class SilenceWatch {
  private quietSince: number | null = null;

  update(peak: number, now: number): boolean {
    if (peak >= SILENT_FLOOR) {
      this.quietSince = null;
      return false;
    }
    this.quietSince ??= now;
    return now - this.quietSince >= SILENT_AFTER_MS;
  }

  reset(): void {
    this.quietSince = null;
  }
}

/**
 * The tab title, so a user in another tab still sees that recording runs. `sent`: Eneo turned out to have a
 * run for the stopped recording already.
 */
export function pageTitle(phase: SessionPhase, elapsedMs: number, flowName: string, sent = false): string {
  switch (phase) {
    case "recording":
      return documentTitle(`Spelar in ${formatClock(elapsedMs)}`);
    case "paused":
    case "interrupted":
      return documentTitle("Pausad");
    // Stopped, not yet a document: "Klart" is the finished document's.
    case "ready":
      return documentTitle(sent ? "Redan skickad" : "Inte skickad");
    default:
      return documentTitle(flowName);
  }
}

/**
 * What the recording bar says now: warnings of what can lose the meeting (no sound, no microphone, no room on
 * the device), shown as alerts above the controls; cautions, what the person can do that would lose sound, said calmly
 * above them too; and calmer notes in its line under them.
 */
export function recordingNotices({
  phase,
  silent,
  lowSpace,
  persistent,
  refused,
  remainingMs,
  muted,
  mutedLong = false,
  mutedGap = null,
  hiddenGap = null,
  stalled = false,
  error = null,
  wakeLock,
  backOnDevice = false,
  makesText = false,
  coarsePointer = false,
}: {
  phase: SessionPhase;
  silent: boolean;
  lowSpace: boolean;
  persistent: boolean;
  refused: DeviceRefusal | null;
  /** The device was full and keeps the recording again. */
  backOnDevice?: boolean;
  /** Recording time the flow still takes; null when it sets no end. */
  remainingMs: number | null;
  /** The microphone's track is muted for now (a headset changing its route). */
  muted: boolean;
  /** Muted long enough in view that it is not coming back by itself. */
  mutedLong?: boolean;
  /** How long the microphone was muted, now that it is back; `away`: the page was in the background meanwhile. */
  mutedGap?: { ms: number; away: boolean } | null;
  /** How long the page was in the background with no audio from the recorder, now that it is back. */
  hiddenGap?: number | null;
  /** The recorder hands over no audio: nothing said now is kept. */
  stalled?: boolean;
  /** What went wrong in keeping the recording while it is captured (the recorder's own sentence). */
  error?: string | null;
  wakeLock: boolean;
  /** The flow ends in text, not a file. */
  makesText?: boolean;
  /** A touch device: the screen locks and apps switch under a recording, which then loses audio. */
  coarsePointer?: boolean;
}): { warnings: Problem[]; cautions: string[]; notes: string[] } {
  const warnings: Problem[] = [];
  const cautions: string[] = [];
  const notes: string[] = [];
  if (phase === "interrupted") {
    // When the device could not keep the pause, that is said in place of the promise.
    warnings.push({ title: "Inspelningen pausades när mikrofonen försvann.", detail: error ?? "Det som spelats in finns kvar." });
  } else if (error) {
    warnings.push({ title: error });
  }
  // A muted microphone is why there is no sound or audio: said alone, and what to do once it has lasted.
  if (phase === "recording" && muted) {
    warnings.push(
      mutedLong
        ? {
            title: "Mikrofonen är fortfarande avstängd.",
            detail:
              "Kontrollera att ingen annan app använder den, till exempel ett samtal. Kommer ljudet inte tillbaka, välj Stoppa och spela in vidare.",
          }
        : { title: "Mikrofonen är tillfälligt borta.", detail: "Inspelningen fortsätter av sig själv när den är tillbaka." },
    );
  } else if (phase === "recording" && stalled) {
    // Stoppa ends the recorder, which then hands over what it holds.
    warnings.push({
      title: "Ljudet sparas inte just nu.",
      detail: "Kontrollera mikrofonen. Står varningen kvar, välj Stoppa: det som hunnit spelas in sparas, och du kan spela in vidare.",
    });
  }
  if ((phase === "recording" || phase === "paused") && remainingMs !== null && remainingMs <= TIME_LEFT_NOTE_MS) {
    // Two steps, never a count: a calm note from fifteen minutes, and a warning from five, when what is said after the
    // end is close to not being recorded. The recorder publishes the time left in these same steps.
    const stops = "Då stoppas inspelningen och det som spelats in sparas.";
    if (remainingMs <= TIME_LEFT_WARNING_MS) warnings.push({ title: "Mindre än 5 minuter kvar till flödets maxlängd.", detail: stops });
    else notes.push(`Mindre än 15 minuter kvar till flödets maxlängd. ${stops}`);
  }
  if (phase === "recording" && silent && !muted) {
    warnings.push({ title: "Vi hör inget från mikrofonen.", detail: "Kontrollera att den inte är avstängd." });
  }
  if (lowSpace && refused !== "full") {
    warnings.push({ title: "Det finns lite lagringsutrymme kvar på enheten.", detail: "Frigör utrymme om du ska spela in länge." });
  }
  if (refused === "full") {
    // Nothing stops, and the store moves what only this tab has onto the device once it has room: freeing room is the way
    // to keep it (a full disk would refuse Spara ljudfil too).
    warnings.push({
      title: "Enheten är full.",
      detail:
        "Inspelningen fortsätter i den här flikens minne. Frigör utrymme, till exempel genom att tömma Hämtade filer och " +
        "papperskorgen, så sparas den på enheten igen. Stäng inte fliken.",
    });
  } else if (refused) {
    // Nothing stops, and Spara ljudfil after Stoppa keeps what only this tab has.
    // The device's copy gone (its data cleared) is more than a device that stops keeping: what came before may be lost.
    const [cause, before] =
      refused === "lost"
        ? ["Inspelningen kan inte längre sparas på enheten.", "Det som spelats in tidigare kan ha försvunnit. "]
        : ["Enheten kan inte spara mer av inspelningen.", ""];
    warnings.push({ title: cause, detail: `${before}Inspelningen fortsätter, men välj Spara ljudfil när du stoppar.` });
  } else if (!persistent) {
    notes.push(
      `Inspelningen sparas bara i den här fliken. Stäng inte fliken innan ${makesText ? "texten är skapad" : "dokumentet är skapat"}.`,
    );
  }
  if (mutedGap) {
    const where = mutedGap.away ? " medan sidan låg i bakgrunden" : "";
    notes.push(`Mikrofonen var avstängd i ${formatDuration(mutedGap.ms)}${where}. Det som sades då kom inte med i inspelningen.`);
  } else if (hiddenGap !== null) {
    notes.push(`Sidan låg i bakgrunden i ${formatDuration(hiddenGap)}. Ljud från den tiden kan saknas.`);
  }
  if (backOnDevice && !refused) notes.push("Det finns plats igen, och inspelningen sparas på enheten.");
  // Said before it happens; the gaps above say it after.
  if (phase === "recording" && coarsePointer) cautions.push("Lås inte skärmen och byt inte app: ljud kan saknas.");
  if (!wakeLock) notes.push("Låt skärmen vara tänd under inspelningen.");
  return { warnings, cautions, notes };
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
 * Whether leaving loses nothing: audio the device keeps (it waits among unsent recordings), nothing being sent and nothing
 * typed that the browser could not keep. "Lämna sidan" is then a choice, not a warning.
 */
export function leaveKeepsWork(state: { persistent: boolean | null; holdsAudio: boolean; sending: boolean; unstored: boolean }): boolean {
  return state.holdsAudio && state.persistent === true && !state.sending && !state.unstored;
}

/**
 * Whether a reload or a closed tab asks the browser's own question. Not for a stopped recording the device keeps: it
 * waits among the unsent recordings and can be continued there, as the page's own question says. It is asked while the
 * recording runs, is being finished (`finishing`), or is held only in this tab, while something is sent, and for typed
 * work the browser could not keep.
 */
export function asksBeforeClosing(state: {
  phase: SessionPhase;
  persistent: boolean | null;
  refused: DeviceRefusal | null;
  finishing: boolean;
  sending: boolean;
  unstored: boolean;
}): boolean {
  const keptOnDevice = state.phase === "ready" && state.persistent === true && !state.refused && !state.finishing;
  return (state.phase !== "setup" && !keptOnDevice) || state.sending || state.unstored;
}

/**
 * What "Lämna sidan?" says. A running recording stops: it does not go on in
 * the background. The recording is promised back among unsent recordings
 * only when the device keeps it; otherwise leaving loses it, and the way to
 * keep it is "Spara ljudfil" (after Stoppa, while recording). A send stops at
 * the stage it is in (`sending`), named as its Avbryt names it: the upload,
 * or the start of the flow once the file is up.
 */
export function leaveWarning(
  persistent: boolean | null,
  phase: SessionPhase,
  sending: false | "uploading" | "starting" = false,
  refused: DeviceRefusal | null = null,
): string {
  const sendStops = sending === "starting" ? "Starten av flödet avbryts" : "Uppladdningen avbryts";
  if (sending && phase === "setup") return `${sendStops}, och filen behöver väljas igen.`;
  const capturing = phase === "recording" || phase === "paused" || phase === "interrupted";
  const stops = sending ? `${sendStops}. ` : capturing ? "Inspelningen stoppas. " : "";
  // A full device holds what came before; only what came after is in this tab, and a full disk would refuse a saved
  // file too: room is the way to keep it, not Spara ljudfil.
  if (refused === "full") {
    return (
      `${stops}Enheten är full, så det senaste av inspelningen finns bara i den här fliken och försvinner när du lämnar ` +
      "sidan. Det som spelades in innan finns kvar på enheten. Stanna kvar och frigör utrymme, så sparas resten där."
    );
  }
  if (persistent) return `${stops}Det som spelats in finns kvar på enheten. Du hittar det på flödets sida.`;
  const lost = `${stops}${capturing ? "Den" : "Inspelningen"} finns bara i den här fliken och försvinner när du lämnar sidan.`;
  return phase === "ready"
    ? `${lost} Välj Spara ljudfil först om du vill behålla den.`
    : `${lost} Stoppa och välj Spara ljudfil först om du vill behålla den.`;
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

/**
 * "Deltagare: Anna Berg, Erik Lund · Mötets namn: KS", for the collapsed details. With nothing filled in it names the
 * fields there are ("Deltagare: inga tillagda"), so the folded row says what can be filled in from it.
 */
export function detailsSummary(fields: FormField[], details: Record<string, unknown>): string {
  const rows = detailRows(fields, details);
  if (rows.length > 0) return rows.map(({ label, text }) => `${label}: ${text}`).join(" · ");
  const labels = fields.map((field) => field.label || field.name);
  if (labels.length !== 1) return `${labels.join(", ")}: inte ifyllda`;
  return `${labels[0]}: ${fields[0].type === "list" ? "inga tillagda" : "inget ifyllt"}`;
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
 * Shown to a room (`room`), it speaks to no one in particular.
 */
export function liveStatusLine(live: LiveStatus, started: boolean, recorder: CaptureStatus, room = false): string | null {
  if (recorder !== "recording") return null;
  const later = room ? "" : ", och texten skapas när du stoppar";
  switch (live) {
    case "reconnecting":
      return started
        ? "Livetexten pausades. Inspelningen fortsätter."
        : "Livetexten kan inte starta just nu. Inspelningen fortsätter.";
    case "unavailable":
      return `Livetexten kunde inte starta. Inspelningen fortsätter${later}.`;
    case "stopped":
      return `Livetexten stannade. Inspelningen fortsätter${later}.`;
    default:
      return null;
  }
}
