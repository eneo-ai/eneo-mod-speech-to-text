// Granskarens vy av en speaker-mapping-checkpoint i Eneo Flows.
//
// Speaker mapping är inget eget API i Eneo: det är ett steg med
// `output_mode = "speaker_mapping"` som alltid pausar i en review-checkpoint
// med `review_mode = "edit"`. Checkpointens `current_payload_json` bär då en
// `speaker_mapping`-nyckel med talarinventariet (SPEAKER_00, SPEAKER_01 …
// med exempelrepliker) och `structured.speakers` med modellens namnförslag.
//
// Klienten skickar tillbaka mappningen som `edited_value` på
// PATCH …/review-checkpoints/{id}/ enligt kontraktet:
//   { speakers: [{ label, name | null, confidence, evidence }] }
// Varje etikett i inventariet måste förekomma exakt en gång. Eneo räknar
// sedan om transkriptet med namnen och uppdaterar `{{transkribering}}`.

import { ApiError, type Json } from "./api";
import { friendlyError } from "./errors";

export type SpeakerConfidence = "low" | "medium" | "high";

export interface SpeakerMappingRow {
  label: string;
  lineCount: number;
  samples: string[];
  name: string | null;
  confidence: SpeakerConfidence;
  evidence: string;
  /** Split off from another speaker at this pause: not in the inventory, sent only once it has a name. */
  split?: boolean;
}

// Type-alias (inte interface) så värdet är tilldelningsbart till Json/ReviewEditedValue.
export type SpeakerMappingEditedValue = {
  speakers: {
    label: string;
    name: string | null;
    confidence: SpeakerConfidence;
    evidence: string;
  }[];
};

type Payload = Json | null | undefined;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isSpeakerMappingCheckpoint(payload: Payload): boolean {
  return record(payload?.speaker_mapping) !== null;
}

/** Deltagarnamn som användaren angav i formulärfältet före körningen. */
export function getSpeakerMappingParticipants(payload: Payload): string[] {
  const extension = record(payload?.speaker_mapping);
  const participants = extension?.participants;
  return Array.isArray(participants)
    ? participants.filter(
        (item): item is string =>
          typeof item === "string" && item.trim() !== "",
      )
    : [];
}

/** Transkriberingssteget som förslaget bygger på, när det är känt. */
export function getSpeakerMappingSourceStep(payload: Payload): {
  stepId: string | null;
  stepOrder: number | null;
} {
  const extension = record(payload?.speaker_mapping);
  return {
    stepId:
      typeof extension?.source_step_id === "string"
        ? extension.source_step_id
        : null,
    stepOrder:
      typeof extension?.source_step_order === "number"
        ? extension.source_step_order
        : null,
  };
}

/**
 * Föreslaget namn → rå etikett. Checkpointens text har redan förslagen
 * insatta, så en parsad textrad måste mappas tillbaka till SPEAKER_NN.
 */
export function proposalNameToLabel(
  rows: readonly SpeakerMappingRow[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name?.trim();
    if (name && !(name in map)) map[name] = row.label;
  }
  return map;
}

/** Om flödet lät modellen föreslå namn som samtalet självt avslöjade. */
export function getSpeakerMappingInferNames(payload: Payload): boolean {
  return record(payload?.speaker_mapping)?.infer_names === true;
}

function confidenceOf(value: unknown): SpeakerConfidence {
  return value === "high" || value === "medium" ? value : "low";
}

/**
 * En rad per diariserad talare. Inventariet är sanningen för vilka rader som
 * finns och i vilken ordning; `structured.speakers` bidrar bara med förslag.
 */
export function buildSpeakerRows(payload: Payload): SpeakerMappingRow[] {
  const extension = record(payload?.speaker_mapping);
  const inventory = Array.isArray(extension?.inventory)
    ? extension.inventory
    : [];
  const structured = record(payload?.structured);
  const proposals = Array.isArray(structured?.speakers)
    ? structured.speakers
    : [];
  const proposalByLabel = new Map<string, Record<string, unknown>>();
  for (const item of proposals) {
    const entry = record(item);
    if (entry && typeof entry.label === "string") {
      proposalByLabel.set(entry.label, entry);
    }
  }
  const rows: SpeakerMappingRow[] = [];
  for (const item of inventory) {
    const entry = record(item);
    if (!entry || typeof entry.label !== "string") continue;
    const proposal = proposalByLabel.get(entry.label);
    rows.push({
      label: entry.label,
      lineCount: typeof entry.line_count === "number" ? entry.line_count : 0,
      samples: Array.isArray(entry.samples)
        ? entry.samples.filter((s): s is string => typeof s === "string")
        : [],
      name:
        typeof proposal?.name === "string" && proposal.name.trim()
          ? proposal.name
          : null,
      confidence: confidenceOf(proposal?.confidence),
      evidence: typeof proposal?.evidence === "string" ? proposal.evidence : "",
    });
  }
  // A speaker the reviewer split off at this pause is not in the inventory; its saved name still is a row.
  for (const [label, proposal] of proposalByLabel) {
    if (rows.some((row) => row.label === label)) continue;
    rows.push({
      label,
      lineCount: 0,
      samples: [],
      name: typeof proposal.name === "string" && proposal.name.trim() ? proposal.name : null,
      confidence: confidenceOf(proposal.confidence),
      evidence: typeof proposal.evidence === "string" ? proposal.evidence : "",
      split: true,
    });
  }
  return rows;
}

/**
 * The rows with a row for every label a speaker edit at this pause introduced
 * (a speaker split in two), so the new speaker can be named too.
 */
export function withSplitLabels(rows: readonly SpeakerMappingRow[], labels: readonly (string | null)[]): SpeakerMappingRow[] {
  const out = [...rows];
  for (const label of labels) {
    if (!label || out.some((row) => row.label === label)) continue;
    out.push({ label, lineCount: 0, samples: [], name: null, confidence: "low", evidence: "", split: true });
  }
  return out;
}

/** Why a speaker name cannot be saved, or null: a name is one line, without tabs or other control characters. */
export function speakerNameProblem(name: string | null): string | null {
  if (name === null) return null;
  return /[\u0000-\u001f\u007f\u2028\u2029]/.test(name)
    ? "Ett namn är en rad, utan radbrytningar, tabbar eller andra styrtecken."
    : null;
}

/** Värdet Eneo förväntar sig som `edited_value` för checkpointen. */
export function buildEditedMapping(
  rows: readonly SpeakerMappingRow[],
): SpeakerMappingEditedValue {
  return {
    // Every inventory label exactly once; a split-off speaker only when it has a name to carry.
    speakers: rows.filter((row) => !row.split || row.name?.trim()).map((row) => ({
      label: row.label,
      name: row.name?.trim() ? row.name.trim() : null,
      confidence: row.confidence,
      evidence: row.evidence,
    })),
  };
}

/** Etikett → namn för alla rader granskaren har namngett. */
export function speakerNamesFromRows(
  rows: readonly SpeakerMappingRow[],
): Record<string, string> {
  const names: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name?.trim();
    if (name) names[row.label] = name;
  }
  return names;
}

/** Namn att erbjuda i väljaren: deltagarlistan plus namn som redan skrivits in. */
export function knownSpeakerNames(
  participants: readonly string[],
  rows: readonly SpeakerMappingRow[],
): string[] {
  const names = [...participants];
  for (const row of rows) {
    const name = row.name?.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

// Speglar Eneos SPEAKER_LINE_RE: "[hh:mm:ss - hh:mm:ss] SPEAKER_NN: text".
const SPEAKER_LINE_RE =
  /^(\[\d{2}:\d{2}:\d{2} - \d{2}:\d{2}:\d{2}\] )(SPEAKER_\d{2,}): (.*)$/;

/**
 * Lokal förhandsvisning av transkriptet med namn insatta. Eneo gör samma
 * omskrivning server-side när mappningen sparas; etiketter utan namn
 * behålls som `SPEAKER_NN`.
 */
export function applySpeakerNames(
  transcript: string,
  names: Record<string, string>,
): string {
  return transcript
    .split("\n")
    .map((line) => {
      const m = SPEAKER_LINE_RE.exec(line);
      if (!m) return line;
      const [, prefix, label, text] = m;
      const name = names[label];
      return name ? `${prefix}${name}: ${text}` : line;
    })
    .join("\n");
}

/** Vilka etiketter som saknar namn och därför lämnas kvar i transkriptet. */
export function unmappedSpeakerLabels(
  rows: readonly SpeakerMappingRow[],
): string[] {
  return rows.filter((row) => !row.name?.trim()).map((row) => row.label);
}

/**
 * A refused save of the names in words. An Eneo from before split speakers
 * could be named refuses the whole mapping for such a name; say which.
 */
export function namingRefusal(err: unknown, rows: readonly SpeakerMappingRow[]): string {
  const split = rows.filter((row) => row.split && row.name?.trim());
  if (err instanceof ApiError && err.code === "typed_io_validation_failed" && split.length > 0) {
    const which = split.map((row) => row.label.replace(/^SPEAKER_(\d+)$/, (_, n) => `Talare ${Number(n) + 1}`)).join(", ");
    return `Eneo tar ännu inte emot namn på en talare som delats upp i granskningen (${which}). Ta bort det namnet och spara igen.`;
  }
  return friendlyError(err);
}
