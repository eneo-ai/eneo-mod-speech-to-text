// Transkript med tidsmarkeringar för uppspelning.
//
// Eneo lagrar ett transkriberingssteg i två lager:
//   1. `input_payload_json.transcription.segments` på steget — en rad per
//      replik med file_index, start/slut (sekunder i den filens ljud),
//      rå talaretikett (SPEAKER_NN) och text.
//   2. `GET …/steps/{stepId}/transcript-words/` — ordtider per segment,
//      adresserade med segment_index. Svarar 404 när inga ord finns.
// Saknas segmenten helt parsas den renderade texten
// `[HH:MM:SS - HH:MM:SS] Talare: text` med sekundprecision.
//
// Ordens teckenpositioner räknas ut här på samma sätt som i Eneo
// (sekventiell sökning, andra försök utan skiljetecken), så att båda vyerna
// markerar samma text för samma ord.

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
  probability: number | null;
  /** Teckenintervall i segmentets text, eller -1/-1 om ordet inte hittades. */
  charStart: number;
  charEnd: number;
  /** Ordet kunde inte placeras i ljudet; tiden är interpolerad. */
  uncertain: boolean;
}

export interface TranscriptSegment {
  fileIndex: number;
  start: number;
  end: number;
  /** Rå talaretikett (SPEAKER_NN) eller null när diarisering saknas. */
  speaker: string | null;
  text: string;
  words?: TranscriptWord[];
}

export interface TranscriptTurnPart {
  segmentIndex: number;
  segment: TranscriptSegment;
}

/** Sammanhängande repliker från samma talare i samma fil. */
export interface TranscriptTurn {
  index: number;
  speaker: string | null;
  fileIndex: number;
  start: number;
  end: number;
  parts: TranscriptTurnPart[];
}

export interface RawTranscriptWord {
  word: string;
  start: number;
  end: number;
  probability?: number | null;
}

export interface TranscriptWordsPayload {
  alignment?: string | null;
  stale?: boolean;
  segments?: {
    segment_index: number;
    words: RawTranscriptWord[];
  }[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Läser `transcription.segments` ur stegets input-metadata. */
export function segmentsFromTranscription(
  transcription: unknown,
): TranscriptSegment[] | null {
  const meta = record(transcription);
  const raw = meta?.segments;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const segments: TranscriptSegment[] = [];
  for (const item of raw) {
    const entry = record(item);
    if (!entry) continue;
    const { start, end, text } = entry;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      typeof text !== "string"
    ) {
      continue;
    }
    segments.push({
      fileIndex: typeof entry.file_index === "number" ? entry.file_index : 0,
      start,
      end,
      speaker: typeof entry.speaker === "string" ? entry.speaker : null,
      text,
    });
  }
  return segments.length > 0 ? segments : null;
}

/** Ljudfilernas id:n för transkriberingssteget, i file_index-ordning. */
export function fileIdsFromTranscription(transcription: unknown): string[] {
  const meta = record(transcription);
  const ids = meta?.file_ids;
  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === "string")
    : [];
}

// "[HH:MM:SS - HH:MM:SS] Talare: text" — talaren är valfri.
const LINE_RE =
  /^\[(\d{2,}):(\d{2}):(\d{2}) - (\d{2,}):(\d{2}):(\d{2})\](?: ([^:\n]+?):)? ?(.*)$/;
// Fler ljudfiler sammanfogas med rubriken "## Del N".
const PART_HEADER_RE = /^## Del (\d+)\b/;

function hms(h: string, m: string, s: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/**
 * Fallback när lagrade segment saknas: parsar den renderade texten.
 * `labelFor` kan mappa ett redan insatt namn tillbaka till sin råa etikett,
 * så att färger och namnval fungerar även när texten innehåller förslagen.
 */
export function parseTranscriptText(
  text: string,
  labelFor: (speaker: string) => string = (speaker) => speaker,
): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let fileIndex = 0;
  for (const line of text.split("\n")) {
    const header = PART_HEADER_RE.exec(line);
    if (header) {
      fileIndex = Math.max(0, Number(header[1]) - 1);
      continue;
    }
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const [, h1, m1, s1, h2, m2, s2, speaker, body] = m;
    segments.push({
      fileIndex,
      start: hms(h1, m1, s1),
      end: hms(h2, m2, s2),
      speaker: speaker ? labelFor(speaker.trim()) : null,
      text: body,
    });
  }
  return segments;
}

const PUNCTUATION_RE = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;

/**
 * Placerar orden i segmentets text. Sökningen är sekventiell så att ett ord
 * som förekommer flera gånger hamnar rätt; ett ord som inte hittas exakt
 * prövas utan inledande/avslutande skiljetecken; ett ord som ändå inte
 * hittas behålls med -1/-1 så att det fortfarande går att spela.
 */
export function locateWords(
  text: string,
  words: readonly RawTranscriptWord[],
  alignment: string | null | undefined,
): TranscriptWord[] {
  let cursor = 0;
  return words.map((w) => {
    const probability =
      typeof w.probability === "number" ? w.probability : null;
    let charStart = text.indexOf(w.word, cursor);
    let charEnd = charStart >= 0 ? charStart + w.word.length : -1;
    if (charStart < 0) {
      const bare = w.word.replace(PUNCTUATION_RE, "");
      if (bare && bare !== w.word) {
        charStart = text.indexOf(bare, cursor);
        charEnd = charStart >= 0 ? charStart + bare.length : -1;
      }
    }
    if (charStart >= 0) cursor = charEnd;
    return {
      word: w.word,
      start: w.start,
      end: w.end,
      probability,
      charStart,
      charEnd,
      // På "forced"-nivån betyder exakt 0.0 att ordet spreds över sitt
      // fönster i stället för att hittas i ljudet.
      uncertain: alignment === "forced" && probability === 0,
    };
  });
}

/** Kopplar ordtider till segmenten via segment_index. Inaktuella ord ignoreras. */
export function attachWords(
  segments: TranscriptSegment[],
  payload: TranscriptWordsPayload | null | undefined,
): TranscriptSegment[] {
  if (!payload || payload.stale || !Array.isArray(payload.segments)) {
    return segments;
  }
  const result = segments.map((s) => ({ ...s }));
  for (const entry of payload.segments) {
    if (
      typeof entry?.segment_index !== "number" ||
      !Array.isArray(entry.words) ||
      entry.words.length === 0
    ) {
      continue;
    }
    const segment = result[entry.segment_index];
    if (!segment) continue;
    segment.words = locateWords(segment.text, entry.words, payload.alignment);
  }
  return result;
}

export function computeTurns(segments: readonly TranscriptSegment[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | null = null;
  segments.forEach((segment, segmentIndex) => {
    if (
      !current ||
      current.speaker !== segment.speaker ||
      current.fileIndex !== segment.fileIndex
    ) {
      current = {
        index: turns.length,
        speaker: segment.speaker,
        fileIndex: segment.fileIndex,
        start: segment.start,
        end: segment.end,
        parts: [],
      };
      turns.push(current);
    }
    current.end = Math.max(current.end, segment.end);
    current.parts.push({ segmentIndex, segment });
  });
  return turns;
}

/** Antal ljudfiler som segmenten refererar. */
export function countFiles(segments: readonly TranscriptSegment[]): number {
  let max = -1;
  for (const s of segments) max = Math.max(max, s.fileIndex);
  return max + 1;
}

/**
 * Segmentet som spelas vid `time` i `fileIndex`: det som omsluter tiden,
 * annars det senaste som börjat före den (tystnad mellan repliker), annars -1.
 */
export function findActiveSegmentIndex(
  segments: readonly TranscriptSegment[],
  fileIndex: number,
  time: number,
): number {
  let lastStarted = -1;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s.fileIndex !== fileIndex) continue;
    if (time >= s.start && time < s.end) return i;
    if (s.start <= time) lastStarted = i;
  }
  return lastStarted;
}

export function findActiveWordIndex(
  words: readonly TranscriptWord[],
  time: number,
): number {
  let lastStarted = -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (time >= w.start && time < w.end) return i;
    if (w.start <= time) lastStarted = i;
  }
  return lastStarted;
}

/** Första repliken för en talare, som hopp-mål för "Lyssna". */
export function firstSegmentForSpeaker(
  segments: readonly TranscriptSegment[],
  speaker: string,
): { fileIndex: number; time: number; segmentIndex: number } | null {
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].speaker === speaker) {
      return { fileIndex: segments[i].fileIndex, time: segments[i].start, segmentIndex: i };
    }
  }
  return null;
}

export function countUncertainWords(segments: readonly TranscriptSegment[]): number {
  let n = 0;
  for (const s of segments) {
    for (const w of s.words ?? []) if (w.uncertain) n++;
  }
  return n;
}

export function formatClock(seconds: number, withHours = false): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return withHours || h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export const SPEAKER_COLOR_COUNT = 6;

/** Stabil färgplats per etikett: SPEAKER_03 → 3 mod 6, annars en enkel hash. */
export function speakerColorIndex(label: string): number {
  const m = /^SPEAKER_(\d+)$/.exec(label);
  if (m) return Number(m[1]) % SPEAKER_COLOR_COUNT;
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % SPEAKER_COLOR_COUNT;
}

/** "SPEAKER_00" → "Talare 1"; andra etiketter visas som de är. */
export function speakerDisplayLabel(label: string): string {
  const m = /^SPEAKER_(\d+)$/.exec(label);
  return m ? `Talare ${Number(m[1]) + 1}` : label;
}
