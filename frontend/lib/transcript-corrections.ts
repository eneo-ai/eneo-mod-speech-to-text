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
//   - V2 avvisar no-op-byten. V3 kan bekräfta samma förslag och lämna
//     talaren oavgjord. Återställning tar bort beslutsöverlägget.
//   - Talaretiketter måste ha formen SPEAKER_NN.

import { effectiveSpeakerLabel, type SpeakerDecision, type TranscriptSegment } from "./transcript";

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
  original_speaker: string | null;
  speaker: string | null;
  decision?: SpeakerDecision;
}

export interface CorrectionSet {
  schemaVersion?: number;
  segmentsHash?: string | null;
  updatedAt?: string;
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
 * Talarspann delas i visningen, med originalankare och oförändrat modellunderlag.
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
  const speakerBySegment = new Map<number, SpeakerEdit>();
  for (const e of set.speaker_edits) {
    if (e.char_start === null) speakerBySegment.set(e.segment_index, e);
  }
  const out = segments.map((segment, index) => {
    const occurrences = bySegment.get(index);
    const speaker = speakerBySegment.get(index);
    if (!occurrences && speaker === undefined) return segment;
    const next: TranscriptSegment = { ...segment, modelSpeaker: segment.modelSpeaker === undefined ? segment.speaker : segment.modelSpeaker };
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
    if (speaker !== undefined) {
      next.speaker = speaker.speaker;
      next.decision = speaker.decision ?? "confirmed";
    }
    return next;
  });
  // Split at original anchors, then map into corrected text. Runs without
  // surviving word times retain the source window; never manufacture times.
  const displayed: TranscriptSegment[] = [];
  const displayedRanges = new Map<number, CorrectedRange[]>();
  const displayedCorrected = new Set<number>();
  out.forEach((segment, index) => {
    const raw = segments[index];
    const edits = set.speaker_edits.filter((e) => e.segment_index === index && e.char_start !== null);
    const mapper = displayRanges(raw.text, bySegment.get(index) ?? []);
    const cuts = [...new Set([0, raw.text.length, ...edits.flatMap((e) => [e.char_start!, e.char_end!])])].sort((a, b) => a - b);
    if (cuts.length === 1) cuts.push(cuts[0]);
    for (let i = 0; i < cuts.length - 1; i++) {
      const from = cuts[i], to = cuts[i + 1];
      const start = mapper.mapOffset(from), end = mapper.mapOffset(to);
      if (start === null || end === null) throw new Error("En texträttning korsar en talargräns. Rättningarna kan inte visas säkert.");
      const edit = edits.find((e) => e.char_start! <= from && e.char_end! >= to);
      const words = segment.words?.filter((w) => w.charStart >= start && w.charEnd <= end && w.charStart >= 0);
      // Replay bounds describe the original source span, even if its word text
      // was corrected. Corrected words themselves remain untimed.
      const sourceWords = raw.words?.filter((w) => w.charStart >= 0 && w.charStart < to && w.charEnd > from);
      const next: TranscriptSegment = {
        ...segment, sourceSegmentIndex: index, sourceCharStart: from, sourceCharEnd: to,
        modelSpeaker: raw.modelSpeaker === undefined ? raw.speaker : raw.modelSpeaker,
        text: segment.text.slice(start, end),
        ...(edit ? { speaker: edit.speaker, decision: edit.decision ?? "confirmed" } : {}),
        ...(edits.length && sourceWords?.length ? { start: Math.min(...sourceWords.map((w) => w.start)), end: Math.max(...sourceWords.map((w) => w.end)) } : {}),
        ...(segment.words ? { words: edits.length ? words?.map((w) => ({ ...w, charStart: w.charStart - start, charEnd: w.charEnd - start })) : segment.words } : {}),
      };
      const displayIndex = displayed.length;
      const localRanges = (ranges.get(index) ?? []).filter((r) => r.start < end && r.end > start || r.start === r.end && r.start >= start && r.start <= end)
        .map((r) => ({ ...r, start: Math.max(start, r.start) - start, end: Math.min(end, r.end) - start }));
      if (localRanges.length) { displayedRanges.set(displayIndex, localRanges); displayedCorrected.add(displayIndex); }
      displayed.push(next);
    }
  });
  return { segments: displayed, corrected: displayedCorrected, ranges: displayedRanges };
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
        const width = /[\uDC00-\uDFFF]/.test(rawText[w.rs - 1]) && w.rs > 1 && /[\uD800-\uDBFF]/.test(rawText[w.rs - 2]) ? 2 : 1;
        w.rs -= width;
        w.ns -= width;
      } else if (w.re < rawText.length) {
        const width = (rawText.codePointAt(w.re) ?? 0) > 0xffff ? 2 : 1;
        w.re += width;
        w.ne += width;
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

/** Validate before allowing a replace-style save. Never erase a newer overlay. */
export function correctionsFromResponse(response: {
  schema_version?: number; segments_hash?: string | null; updated_at?: string; stale: boolean; revision: number;
  occurrences: CorrectionOccurrence[]; speaker_edits: SpeakerEdit[];
}, segments: readonly TranscriptSegment[], expectedHash?: string | null): CorrectionSet {
  const version = response.schema_version ?? 2;
  if (expectedHash && response.segments_hash && expectedHash !== response.segments_hash) {
    throw new Error("Rättningarnas transkriptunderlag har ändrats. Läs in det aktuella underlaget innan du fortsätter.");
  }
  // Eneo anchors use Unicode code points; DOM/string offsets use UTF-16.
  const offset = (index: number, value: number) => {
    const codepoints = Array.from(segments[index]?.text ?? "");
    if (!segments[index] || !Number.isInteger(value) || value < 0 || value > codepoints.length) throw new Error("Rättningarnas teckenintervall är ogiltigt.");
    return codepoints.slice(0, value).join("").length;
  };
  response = { ...response,
    occurrences: response.occurrences.map((o) => ({ ...o, char_start: offset(o.segment_index, o.char_start), char_end: offset(o.segment_index, o.char_end) })),
    speaker_edits: (response.speaker_edits ?? []).map((e) => ({ ...e,
      char_start: e.char_start === null ? null : offset(e.segment_index, e.char_start),
      char_end: e.char_end === null ? null : offset(e.segment_index, e.char_end),
    })),
  };
  if (![1, 2, 3].includes(version)) throw new Error(`Rättningarnas version (${version}) stöds inte. Uppdatera Lyssna innan du fortsätter.`);
  if (response.stale) throw new Error("Rättningarna gäller ett äldre transkript. Läs in det aktuella underlaget innan du fortsätter.");
  const occupiedText = new Map<number, [number, number][]>();
  for (const occurrence of response.occurrences) {
    const raw = segments[occurrence.segment_index];
    const spans = occupiedText.get(occurrence.segment_index) ?? [];
    if (!raw || !Number.isInteger(occurrence.char_start) || !Number.isInteger(occurrence.char_end) ||
        occurrence.char_start < 0 || occurrence.char_end <= occurrence.char_start || occurrence.char_end > raw.text.length ||
        raw.text.slice(occurrence.char_start, occurrence.char_end) !== occurrence.original ||
        spans.some(([start, end]) => occurrence.char_start < end && occurrence.char_end > start)) {
      throw new Error("Texträttningarnas underlag stämmer inte. Rättningarna kan inte visas säkert.");
    }
    spans.push([occurrence.char_start, occurrence.char_end]); occupiedText.set(occurrence.segment_index, spans);
  }
  const occupiedSpeakers = new Map<number, [number, number][]>();
  for (const edit of response.speaker_edits ?? []) {
    const raw = segments[edit.segment_index];
    if (!raw || edit.original_speaker !== raw.speaker ||
        (edit.decision !== undefined && !["confirmed", "unresolved"].includes(edit.decision)) ||
        (edit.speaker !== null && !/^SPEAKER_\d+$/.test(edit.speaker)) ||
        (edit.char_start === null && (edit.char_end !== null || edit.original !== null)) ||
        (version === 3 && !["confirmed", "unresolved"].includes(edit.decision ?? "")) ||
        (edit.decision === "confirmed" && edit.speaker === null) ||
        (edit.decision === "unresolved" && edit.speaker !== null) ||
        (edit.char_start !== null && (!Number.isInteger(edit.char_start) || !Number.isInteger(edit.char_end) || edit.char_end === null || edit.char_start < 0 || edit.char_end <= edit.char_start || edit.char_end > raw.text.length || raw.text.slice(edit.char_start, edit.char_end) !== edit.original))) {
      throw new Error("Talarbeslutens underlag eller format stämmer inte. Rättningarna kan inte visas säkert.");
    }
  }
  for (const edit of response.speaker_edits ?? []) {
    const spans = occupiedSpeakers.get(edit.segment_index) ?? [];
    const start = edit.char_start ?? -Infinity, end = edit.char_end ?? Infinity;
    if (spans.some(([a, b]) => start < b && end > a)) throw new Error("Talarbeslutens intervall krockar. Rättningarna kan inte visas säkert.");
    spans.push([start, end]); occupiedSpeakers.set(edit.segment_index, spans);
  }

  const set = { schemaVersion: version, updatedAt: response.updated_at, segmentsHash: expectedHash ?? response.segments_hash, occurrences: response.occurrences, speaker_edits: response.speaker_edits ?? [], revision: response.revision };
  applyCorrections(segments, set);
  return set;
}

/** Guard full-list writes until the original base hash is known. */
export function correctionWriteProblem(set: CorrectionSet): string | null {
  const version = set.schemaVersion ?? 2;
  if (![1, 2, 3].includes(version)) return "Rättningarnas version stöds inte. Uppdatera Lyssna.";
  if (version >= 3 && !/^[0-9a-f]{64}$/.test(set.segmentsHash ?? "")) return "Transkriptets originalunderlag saknas. Läs in sidan igen innan du sparar.";
  if (version < 3 && set.speaker_edits.some((e) => e.decision === "unresolved" || e.speaker === null || e.original_speaker === null || e.speaker === e.original_speaker)) {
    return "Talarbeslut kräver Eneos uppdaterade transkriptunderlag.";
  }
  return null;
}

export function correctionRequest(set: CorrectionSet, segments: readonly TranscriptSegment[], revision = set.revision) {
  const problem = correctionWriteProblem(set);
  if (problem) throw new Error(problem);
  const offset = (index: number, value: number) => Array.from(segments[index].text.slice(0, value)).length;
  return {
    schema_version: set.schemaVersion === 3 ? 3 as const : 2 as const,
    ...(set.schemaVersion === 3 ? { segments_hash: set.segmentsHash! } : {}),
    expected_revision: revision,
    occurrences: set.occurrences.map((o) => ({ ...o, char_start: offset(o.segment_index, o.char_start), char_end: offset(o.segment_index, o.char_end) })),
    speaker_edits: set.speaker_edits.map((e) => ({ ...e, decision: e.decision ?? "confirmed" as const,
      char_start: e.char_start === null ? null : offset(e.segment_index, e.char_start),
      char_end: e.char_end === null ? null : offset(e.segment_index, e.char_end),
    })),
  };
}

/** Last explicit decision wins only within its original text interval. Null removes it. */
export function withSpeakerDecision(set: CorrectionSet, segments: readonly TranscriptSegment[], segmentIndex: number,
  start: number | null, end: number | null, decision: SpeakerDecision | null, speaker: string | null): CorrectionSet {
  const raw = segments[segmentIndex];
  if (!raw) throw new Error("Transkriptpassagen saknas.");
  if (decision === "confirmed" && (!speaker || !/^SPEAKER_\d{2,}$/.test(speaker))) throw new Error("Välj en talare för att bekräfta.");
  const from = start ?? 0, to = end ?? raw.text.length;
  if ((start === null) !== (end === null) || from < 0 || to > raw.text.length || (start !== null && to <= from)) throw new Error("Välj ett giltigt ordintervall.");
  const edits: SpeakerEdit[] = [];
  const anchored = (e: SpeakerEdit, a: number, b: number): SpeakerEdit => ({ ...e, char_start: a, char_end: b, original: raw.text.slice(a, b) });
  for (const e of set.speaker_edits) {
    if (e.segment_index !== segmentIndex) { edits.push(e); continue; }
    const a = e.char_start ?? 0, b = e.char_end ?? raw.text.length;
    if (a >= to || b <= from) { edits.push(e); continue; }
    if (a < from) edits.push(anchored(e, a, from));
    if (b > to) edits.push(anchored(e, to, b));
  }
  if (decision) edits.push({ segment_index: segmentIndex, char_start: start, char_end: end,
    original: start === null ? null : raw.text.slice(from, to), original_speaker: raw.speaker,
    speaker: decision === "unresolved" ? null : speaker, decision });
  const next = { ...set, schemaVersion: 3, speaker_edits: edits.sort((a, b) => a.segment_index - b.segment_index || (a.char_start ?? -1) - (b.char_start ?? -1)) };
  applyCorrections(segments, next); // Reject boundaries crossed by a text correction.
  return next;
}

/** "00:01:05": the transcript text's own timestamp, as Eneo writes it and parseTranscriptText reads it. */
function textTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

/** Plain text uses the same effective attribution and spans as the player. */
export function renderReviewedTranscript(segments: readonly TranscriptSegment[], set: CorrectionSet, names: Readonly<Record<string, string>> = {}): string {
  const out = applyCorrections(segments, set).segments;
  const lines: string[] = [];
  let file = -1;
  const multiple = new Set(out.map((s) => s.fileIndex)).size > 1;
  for (const segment of out) {
    if (!segment.text.trim()) continue;
    if (multiple && segment.fileIndex !== file) { lines.push(`## Del ${segment.fileIndex + 1}`, ""); file = segment.fileIndex; }
    const label = effectiveSpeakerLabel(segment, (s) => s ? names[s]?.trim() || s : "");
    const marker = label === "Överlappande tal – osäker talare" || label === "Talare går inte att avgöra";
    lines.push(`[${textTimestamp(segment.start)} - ${textTimestamp(segment.end)}] ${label ? (marker ? `[${label}]` : label) + ": " : ""}${segment.text.trim()}`);
  }
  return lines.join("\n");
}

/** Once a save fails, queued replacements must wait for an explicit retry. */
export function appendCorrectionSave(previous: Promise<boolean>, write: () => Promise<boolean>): Promise<boolean> {
  return previous.then((saved) => saved ? write() : false);
}
