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

/** Ett rättat spann i den visade (korrigerade) texten. */
export interface CorrectedRange {
  start: number;
  end: number;
  original: string;
}

/**
 * Rättade spann i visningskoordinater, samt en funktion som flyttar en
 * råtextposition till motsvarande visningsposition (null om positionen
 * ligger inuti ett rättat spann).
 */
function displayRanges(
  rawText: string,
  occurrences: readonly CorrectionOccurrence[],
): { ranges: CorrectedRange[]; mapOffset: (rawOffset: number) => number | null } {
  const ordered = [...occurrences]
    .filter(
      (o) => o.char_start >= 0 && o.char_end <= rawText.length && o.char_start <= o.char_end,
    )
    .sort((a, b) => a.char_start - b.char_start);
  const ranges: CorrectedRange[] = [];
  let delta = 0;
  for (const o of ordered) {
    const start = o.char_start + delta;
    ranges.push({ start, end: start + o.corrected.length, original: o.original });
    delta += o.corrected.length - (o.char_end - o.char_start);
  }
  const mapOffset = (rawOffset: number): number | null => {
    let shift = 0;
    for (const o of ordered) {
      if (rawOffset <= o.char_start) break;
      if (rawOffset < o.char_end) return null;
      shift += o.corrected.length - (o.char_end - o.char_start);
    }
    return rawOffset + shift;
  };
  return { ranges, mapOffset };
}

/**
 * Segmenten som de ska visas: korrigerad text, omtilldelad talare och de
 * rättade spannen i visningskoordinater. Ordtider som inte berörs av en
 * rättning flyttas med; ord som överlappar en rättning tas bort (deras
 * text finns inte längre).
 * Span-baserade talarbyten (delar av en replik) visas inte; modulen skapar
 * bara hela-segment-byten.
 */
export function applyCorrections(
  segments: readonly TranscriptSegment[],
  set: CorrectionSet | null | undefined,
): {
  segments: TranscriptSegment[];
  corrected: Set<number>;
  ranges: Map<number, CorrectedRange[]>;
} {
  const corrected = new Set<number>();
  const ranges = new Map<number, CorrectedRange[]>();
  if (!set) return { segments: [...segments], corrected, ranges };
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
      const display = displayRanges(segment.text, occurrences);
      ranges.set(index, display.ranges);
      corrected.add(index);
      if (segment.words) {
        const words = [];
        for (const w of segment.words) {
          if (w.charStart < 0) {
            words.push(w);
            continue;
          }
          // Ord som överlappar en rättning finns inte längre i texten.
          const touched = occurrences.some(
            (o) => w.charStart < o.char_end && w.charEnd > o.char_start,
          );
          if (touched) continue;
          const start = display.mapOffset(w.charStart);
          const end = display.mapOffset(w.charEnd);
          if (start === null || end === null || end < start) continue;
          words.push({ ...w, charStart: start, charEnd: end });
        }
        next.words = words;
      }
    }
    if (speaker !== undefined) next.speaker = speaker;
    return next;
  });
  return { segments: out, corrected, ranges };
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

const TOKEN_RE = /\s+|[^\s]+/g;

function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

/**
 * En redigerad rad → en ersättning per ändrat ställe, förankrad i råtexten.
 * Skillnaden räknas på ord- och blankstegstoken (LCS), så två rättningar i
 * samma replik blir två spann i stället för ett som täcker allt emellan. En
 * ren insättning tar med grannbokstaven så att `original` aldrig blir tomt;
 * spann som därmed rör vid varandra slås ihop.
 */
export function occurrencesForLine(
  segmentIndex: number,
  rawText: string,
  newText: string,
): CorrectionOccurrence[] {
  if (rawText === newText) return [];
  const a = tokenize(rawText);
  const b = tokenize(newText);
  // LCS över token.
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Gå igenom och samla ändringsklumpar i teckenkoordinater.
  type Hunk = { rs: number; re: number; ns: number; ne: number };
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let ra = 0; // teckenposition i råtexten
  let nb = 0; // teckenposition i nya texten
  let open: Hunk | null = null;
  const closeHunk = () => {
    if (open) hunks.push(open);
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      closeHunk();
      ra += a[i].length;
      nb += b[j].length;
      i++;
      j++;
      continue;
    }
    if (!open) open = { rs: ra, re: ra, ns: nb, ne: nb };
    if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      nb += b[j].length;
      open.ne = nb;
      j++;
    } else {
      ra += a[i].length;
      open.re = ra;
      i++;
    }
  }
  closeHunk();

  // Insättningar får ett grannbokstav; sammanhängande spann slås ihop.
  const widened: Hunk[] = [];
  for (const h of hunks) {
    const w = { ...h };
    if (w.rs === w.re) {
      if (w.rs > 0) {
        w.rs--;
        w.ns--;
      } else if (w.re < rawText.length) {
        w.re++;
        w.ne++;
      } else {
        continue; // tom råtext — inget att förankra i
      }
    }
    const prev = widened[widened.length - 1];
    if (prev && w.rs <= prev.re) {
      prev.re = Math.max(prev.re, w.re);
      prev.ne = Math.max(prev.ne, w.ne);
    } else {
      widened.push(w);
    }
  }
  return widened.map((h) => ({
    segment_index: segmentIndex,
    char_start: h.rs,
    char_end: h.re,
    original: rawText.slice(h.rs, h.re),
    corrected: newText.slice(h.ns, h.ne),
  }));
}

/** Bakåtkompatibelt: första spannet, eller null om raden är oförändrad. */
export function occurrenceForLine(
  segmentIndex: number,
  rawText: string,
  newText: string,
): CorrectionOccurrence | null {
  return occurrencesForLine(segmentIndex, rawText, newText)[0] ?? null;
}

/** Ersätter segmentets korrigeringar (tom lista eller null tar bort dem). */
export function withLineCorrection(
  set: CorrectionSet,
  segmentIndex: number,
  occurrence: CorrectionOccurrence | readonly CorrectionOccurrence[] | null,
): CorrectionSet {
  const occurrences = set.occurrences.filter((o) => o.segment_index !== segmentIndex);
  if (Array.isArray(occurrence)) occurrences.push(...occurrence);
  else if (occurrence) occurrences.push(occurrence as CorrectionOccurrence);
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
