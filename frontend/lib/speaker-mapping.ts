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

import type { Json } from "./api";

export type SpeakerConfidence = "low" | "medium" | "high";

export interface SpeakerMappingRow {
  label: string;
  lineCount: number;
  samples: string[];
  name: string | null;
  confidence: SpeakerConfidence;
  evidence: string;
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
  return rows;
}

/** Värdet Eneo förväntar sig som `edited_value` för checkpointen. */
export function buildEditedMapping(
  rows: readonly SpeakerMappingRow[],
): SpeakerMappingEditedValue {
  return {
    speakers: rows.map((row) => ({
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
