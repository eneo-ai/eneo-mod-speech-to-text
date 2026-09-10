// Icke-destruktiva transkriptkorrigeringar (Eneo "transcript corrections").
//
// Eneo skriver aldrig om det råa transkriptet. I stället lagras per
// transkriberingssteg en uppsättning teckenintervall-ersättningar
// (`occurrences`) och talarbyten (`speaker_edits`), förankrade i stegets
// lagrade `transcription.segments`. Korrigeringarna appliceras vid läsning
// och viks in i texten när granskningen godkänns.
//
// Regler från Eneo som den här modulen måste följa:
//   - `original` måste matcha råtexten exakt på [char_start, char_end)
//     och intervallet måste vara icke-tomt (en ren insättning uttrycks genom
//     att ta med ett grannbokstav i intervallet).
//   - Intervall inom ett segment får inte överlappa.
//   - Ett talarbyte som behåller den lagrade talaren avvisas; "återställ"
//     uttrycks genom att ta bort bytet.
//   - Talaretiketter måste ha formen SPEAKER_NN.

import type { TranscriptSegment } from "./transcript";

export interface CorrectionOccurrence {
  segment_index: number;
  char_start: number;
  char_end: number;
  original: string;
  corrected: string;
}

export interface SpeakerEdit {
  segment_index: number;
  char_start: number | null;
  char_end: number | null;
  original: string | null;
  original_speaker: string;
  speaker: string;
}

export interface CorrectionSet {
  occurrences: CorrectionOccurrence[];
  speaker_edits: SpeakerEdit[];
  /** Eneos revision för optimistisk låsning; null innan något sparats. */
  revision: number | null;
}

export const EMPTY_CORRECTIONS: CorrectionSet = {
  occurrences: [],
  speaker_edits: [],
  revision: null,
};

/** Segmentets text med korrigeringarna insatta. */
export function correctedSegmentText(
  rawText: string,
  occurrences: readonly CorrectionOccurrence[],
): string {
  const ordered = [...occurrences].sort((a, b) => b.char_start - a.char_start);
  let text = rawText;
  for (const o of ordered) {
    if (o.char_start < 0 || o.char_end > text.length || o.char_start > o.char_end) {
      continue;
    }
    text = text.slice(0, o.char_start) + o.corrected + text.slice(o.char_end);
  }
  return text;
}

/**
 * Segmenten som de ska visas: korrigerad text och omtilldelad talare.
 * Ett korrigerat segment tappar sina ordtider — teckenpositionerna gäller
 * råtexten — och markeras därför per replik i stället för per ord.
 * Span-baserade talarbyten (delar av en replik) visas inte; modulen skapar
 * bara hela-segment-byten.
 */
export function applyCorrections(
  segments: readonly TranscriptSegment[],
  set: CorrectionSet | null | undefined,
): { segments: TranscriptSegment[]; corrected: Set<number> } {
  const corrected = new Set<number>();
  if (!set) return { segments: [...segments], corrected };
  const bySegment = new Map<number, CorrectionOccurrence[]>();
  for (const o of set.occurrences) {
    const list = bySegment.get(o.segment_index) ?? [];
    list.push(o);
    bySegment.set(o.segment_index, list);
  }
  const speakerBySegment = new Map<number, string>();
  for (const e of set.speaker_edits) {
    if (e.char_start === null) speakerBySegment.set(e.segment_index, e.speaker);
  }
  const out = segments.map((segment, index) => {
    const occurrences = bySegment.get(index);
    const speaker = speakerBySegment.get(index);
    if (!occurrences && speaker === undefined) return segment;
    const next: TranscriptSegment = { ...segment };
    if (occurrences && occurrences.length > 0) {
      next.text = correctedSegmentText(segment.text, occurrences);
      delete next.words;
      corrected.add(index);
    }
    if (speaker !== undefined) next.speaker = speaker;
    return next;
  });
  return { segments: out, corrected };
}

/** Råtexten för ett segment som redan har en korrigering — för "Rättad från". */
export function originalTextFor(
  segments: readonly TranscriptSegment[],
  set: CorrectionSet,
  segmentIndex: number,
): string | null {
  return set.occurrences.some((o) => o.segment_index === segmentIndex)
    ? (segments[segmentIndex]?.text ?? null)
    : null;
}

/**
 * En redigerad rad → en enda ersättning mot råtexten, eller null om texten
 * är oförändrad. Ändringen isoleras med gemensamt prefix/suffix; en ren
 * insättning utvidgas med ett tecken så att `original` aldrig blir tomt.
 */
export function occurrenceForLine(
  segmentIndex: number,
  rawText: string,
  newText: string,
): CorrectionOccurrence | null {
  if (rawText === newText) return null;
  const rawChars = Array.from(rawText);
  const newChars = Array.from(newText);
  let prefix = 0;
  while (
    prefix < rawChars.length &&
    prefix < newChars.length &&
    rawChars[prefix] === newChars[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < rawChars.length - prefix &&
    suffix < newChars.length - prefix &&
    rawChars[rawChars.length - 1 - suffix] === newChars[newChars.length - 1 - suffix]
  ) {
    suffix++;
  }
  let startChar = prefix;
  let endChar = rawChars.length - suffix;
  let newStart = prefix;
  let newEnd = newChars.length - suffix;
  if (startChar === endChar) {
    // Ren insättning: ta med grannbokstaven till vänster, annars höger.
    if (startChar > 0) {
      startChar--;
      newStart--;
    } else if (endChar < rawChars.length) {
      endChar++;
      newEnd++;
    } else {
      return null; // råtexten är tom — inget att förankra i
    }
  }
  // Teckenpositioner räknas i UTF-16-kodenheter som i Eneo (Python-str-index
  // motsvarar kodpunkter; för svensk text är de lika utom vid emoji).
  const toIndex = (chars: string[], n: number) => chars.slice(0, n).join("").length;
  return {
    segment_index: segmentIndex,
    char_start: toIndex(rawChars, startChar),
    char_end: toIndex(rawChars, endChar),
    original: rawChars.slice(startChar, endChar).join(""),
    corrected: newChars.slice(newStart, newEnd).join(""),
  };
}

/** Ersätter segmentets korrigering (null tar bort den). */
export function withLineCorrection(
  set: CorrectionSet,
  segmentIndex: number,
  occurrence: CorrectionOccurrence | null,
): CorrectionSet {
  const occurrences = set.occurrences.filter((o) => o.segment_index !== segmentIndex);
  if (occurrence) occurrences.push(occurrence);
  occurrences.sort(
    (a, b) => a.segment_index - b.segment_index || a.char_start - b.char_start,
  );
  return { ...set, occurrences };
}

/**
 * Tilldelar hela segmentet en annan talare. Att välja den lagrade talaren
 * igen tar bort bytet, eftersom Eneo avvisar no-op-byten.
 */
export function withSpeakerEdit(
  set: CorrectionSet,
  segmentIndex: number,
  storedSpeaker: string,
  speaker: string,
): CorrectionSet {
  const speaker_edits = set.speaker_edits.filter(
    (e) => !(e.segment_index === segmentIndex && e.char_start === null),
  );
  if (speaker !== storedSpeaker) {
    speaker_edits.push({
      segment_index: segmentIndex,
      char_start: null,
      char_end: null,
      original: null,
      original_speaker: storedSpeaker,
      speaker,
    });
  }
  speaker_edits.sort((a, b) => a.segment_index - b.segment_index);
  return { ...set, speaker_edits };
}

export function sameCorrections(a: CorrectionSet, b: CorrectionSet): boolean {
  return (
    JSON.stringify([a.occurrences, a.speaker_edits]) ===
    JSON.stringify([b.occurrences, b.speaker_edits])
  );
}

export function correctionCount(set: CorrectionSet): number {
  return set.occurrences.length + set.speaker_edits.length;
}
