"use client";

import { Headphones } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  knownSpeakerNames,
  type SpeakerMappingRow,
} from "@/lib/speaker-mapping";
import { speakerColorIndex, speakerDisplayLabel } from "@/lib/transcript";

const NONE = "__none__";
const OTHER = "__other__";

const SELECT_CLASS =
  "h-9 w-full min-w-0 rounded-md border border-rule bg-paper px-2.5 text-[13px] text-ink shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-paper disabled:cursor-not-allowed disabled:opacity-50";

function confidenceWord(confidence: SpeakerMappingRow["confidence"]): string {
  if (confidence === "high") return "hög";
  if (confidence === "medium") return "medelhög";
  return "låg";
}

/**
 * En rad per talare: färgprick, "Talare N", namnval och en lyssna-knapp som
 * hoppar till talarens första replik i spelaren. Detaljer om förslaget ligger
 * på en tyst andra rad; motiveringen bakom en "Varför?"-utfällning.
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
  // Rader där granskaren valt "Annan person …" men inte skrivit något ännu.
  const [forcedOther, setForcedOther] = useState<Set<string>>(() => new Set());

  const names = knownSpeakerNames(participants, rows);
  const proposalByLabel = new Map(proposals.map((p) => [p.label, p]));

  function isCustom(row: SpeakerMappingRow): boolean {
    return (
      forcedOther.has(row.label) ||
      (row.name !== null && !participants.includes(row.name))
    );
  }

  function selectValue(row: SpeakerMappingRow): string {
    if (isCustom(row)) return OTHER;
    return row.name ?? NONE;
  }

  function update(label: string, patch: Partial<SpeakerMappingRow>) {
    onChange(rows.map((r) => (r.label === label ? { ...r, ...patch } : r)));
  }

  function onSelect(row: SpeakerMappingRow, value: string) {
    if (value === OTHER) {
      setForcedOther((prev) => new Set(prev).add(row.label));
      update(row.label, {
        name: participants.includes(row.name ?? "") ? "" : row.name,
      });
      return;
    }
    setForcedOther((prev) => {
      const next = new Set(prev);
      next.delete(row.label);
      return next;
    });
    update(row.label, { name: value === NONE ? null : value });
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
        const custom = isCustom(row);
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
              <select
                aria-label={`Namn för ${title}`}
                value={selectValue(row)}
                disabled={disabled}
                onChange={(e) => onSelect(row, e.target.value)}
                className={cn(SELECT_CLASS, "flex-1")}
              >
                {names.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                <option value={OTHER}>Annan person …</option>
                <option value={NONE}>Ingen (behåll etiketten)</option>
              </select>
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
              {custom && (
                <Input
                  value={row.name ?? ""}
                  disabled={disabled}
                  placeholder="Skriv namn"
                  aria-label={`Skriv namn för ${title}`}
                  className="mt-2 h-9 text-[13px]"
                  onChange={(e) => {
                    setForcedOther((prev) => new Set(prev).add(row.label));
                    update(row.label, { name: e.target.value });
                  }}
                />
              )}
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
