"use client";

import { Headphones } from "lucide-react";
import { NameCombobox } from "@/components/NameCombobox";
import {
  knownSpeakerNames,
  type SpeakerMappingRow,
} from "@/lib/speaker-mapping";
import { speakerColorIndex, speakerDisplayLabel } from "@/lib/transcript";

function confidenceWord(confidence: SpeakerMappingRow["confidence"]): string {
  if (confidence === "high") return "hög";
  if (confidence === "medium") return "medelhög";
  return "låg";
}

/**
 * En rad per talare: färgprick, "Talare N", ett namnfält (välj deltagare eller
 * skriv ett nytt namn) och en lyssna-knapp som hoppar till talarens första
 * replik i spelaren. Detaljer om förslaget ligger på en tyst andra rad;
 * motiveringen bakom en "Varför?"-utfällning.
 */
export function SpeakerMappingEditor({
  rows,
  proposals,
  participants,
  inferred = false,
  disabled = false,
  showSamples = false,
  onChange,
  onListen,
}: {
  rows: SpeakerMappingRow[];
  /** Modellens ursprungliga förslag, för att beskriva raden oberoende av val. */
  proposals: readonly SpeakerMappingRow[];
  participants: string[];
  /** Modellen fick föreslå namn som samtalet självt avslöjade. */
  inferred?: boolean;
  disabled?: boolean;
  /** Visa exempelrepliker (när ljud saknas är de enda ledtråden). */
  showSamples?: boolean;
  onChange: (rows: SpeakerMappingRow[]) => void;
  /** Hoppa till talarens första replik. Saknas när inget ljud finns. */
  onListen?: (label: string) => void;
}) {
  const names = knownSpeakerNames(participants, rows);
  const proposalByLabel = new Map(proposals.map((p) => [p.label, p]));

  function update(label: string, patch: Partial<SpeakerMappingRow>) {
    onChange(rows.map((r) => (r.label === label ? { ...r, ...patch } : r)));
  }

  function describe(row: SpeakerMappingRow): string {
    const proposal = proposalByLabel.get(row.label);
    const parts = [`${row.lineCount} ${row.lineCount === 1 ? "replik" : "repliker"}`];
    if (proposal?.name) {
      parts.push(`förslag med ${confidenceWord(proposal.confidence)} säkerhet`);
      if (inferred && !participants.includes(proposal.name)) {
        parts.push("namnet hörs i samtalet");
      }
    } else {
      parts.push("inget förslag");
    }
    return parts.join(" · ");
  }

  return (
    <ul className="flex flex-col">
      {rows.map((row) => {
        const color = `hsl(var(--speaker-${speakerColorIndex(row.label)}))`;
        const proposal = proposalByLabel.get(row.label);
        const title = speakerDisplayLabel(row.label);
        return (
          <li
            key={row.label}
            className="border-b border-rule-soft py-3 first:pt-0 last:border-0 last:pb-0"
          >
            <div className="flex items-center gap-2.5">
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: color }}
              />
              <span
                className="w-[4.5rem] shrink-0 text-[13px] font-semibold leading-tight"
                style={{ color }}
              >
                {title}
              </span>
              <NameCombobox
                aria-label={`Namn för ${title}`}
                value={row.name}
                options={names.filter((n) => n !== row.name?.trim() || participants.includes(n))}
                disabled={disabled}
                onChange={(name) => update(row.label, { name })}
                className="flex-1"
              />
              {onListen && (
                <button
                  type="button"
                  onClick={() => onListen(row.label)}
                  disabled={disabled}
                  aria-label={`Lyssna på ${title}`}
                  title="Lyssna"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-rule-soft bg-paper text-ink-soft transition-colors hover:border-ink/40 hover:text-ink disabled:opacity-50"
                >
                  <Headphones className="h-4 w-4" strokeWidth={2} />
                </button>
              )}
            </div>

            <div className="pl-[calc(0.625rem+0.625rem+4.5rem+0.625rem)]">
              <p className="mt-1.5 text-[12px] leading-snug text-ink-mute">
                {describe(row)}
              </p>
              {showSamples && row.samples.length > 0 && (
                <ul className="mt-1.5 flex flex-col gap-0.5 text-[12px] italic leading-snug text-ink-soft">
                  {row.samples.map((sample, i) => (
                    <li key={i} className="truncate">
                      “{sample}”
                    </li>
                  ))}
                </ul>
              )}
              {proposal?.evidence && (
                <details className="mt-1 text-[12px] leading-snug">
                  <summary className="cursor-pointer select-none text-ink-mute hover:text-ink">
                    Varför?
                  </summary>
                  <p className="mt-1 text-ink-soft">{proposal.evidence}</p>
                </details>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
