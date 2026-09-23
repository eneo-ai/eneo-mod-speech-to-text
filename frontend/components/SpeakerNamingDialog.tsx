"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Headphones } from "lucide-react";
import { NameCombobox } from "@/components/NameCombobox";
import { SpeakerMark } from "@/components/TranscriptPlayer";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { speakerNameProblem, type SpeakerMappingRow } from "@/lib/speaker-mapping";
import { speakerDisplayLabel } from "@/lib/transcript";

/**
 * The keyboard on a phone covers the lower part of the screen without making
 * the page shorter; the dialog follows the visible part, so the focused field
 * and "Spara namnen" stay in reach.
 */
function useVisibleHeight(active: boolean): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const viewport = typeof window === "undefined" ? null : window.visualViewport;
    if (!active || !viewport) return;
    const update = () => setHeight(viewport.height);
    update();
    viewport.addEventListener("resize", update);
    // Some browsers shrink the page itself for the keyboard instead.
    window.addEventListener("resize", update);
    return () => {
      viewport.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
    };
  }, [active]);
  // Once the dialog has its new height, the field being typed in stays in sight above the keyboard.
  useEffect(() => {
    const focused = document.activeElement;
    if (height && focused instanceof HTMLElement && focused.closest('[role="dialog"]')) focused.scrollIntoView({ block: "nearest" });
  }, [height]);
  return height;
}

/**
 * "Namnge talarna" at the review pause: one row per speaker with a sample to
 * listen to, the first thing they say, how many passages they have, and a name
 * picked from the participants or typed. Names are saved to the pause's edit,
 * which is what reaches the transcript and the document.
 */
export function SpeakerNamingDialog({
  rows,
  participants,
  passages,
  quote,
  disabled = false,
  onListen,
  listenUnavailableReason,
  onSave,
  children,
}: {
  rows: readonly SpeakerMappingRow[];
  /** The names entered before the run: suggestions, never assumed. */
  participants: readonly string[];
  /** How many passages a speaker has in the transcript. */
  passages: (label: string) => number;
  /** The first thing a speaker says, quoted in the row. */
  quote: (label: string) => string | null;
  disabled?: boolean;
  /** Plays a short sample of the speaker through the page's one player. */
  onListen?: (label: string) => void;
  listenUnavailableReason?: (label: string) => string | null;
  /** Saves the names; returns why they were not saved, or null. */
  onSave: (rows: SpeakerMappingRow[]) => Promise<string | null>;
  /** The button that opens the dialog; focus returns to it on close. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SpeakerMappingRow[]>([...rows]);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const height = useVisibleHeight(open);

  const title = (label: string) => speakerDisplayLabel(label);
  // A name given to another speaker is said quietly; only the row's own choice is checked.
  const usedBy = (name: string, label: string) => {
    const other = draft.find((row) => row.label !== label && row.name?.trim() === name.trim());
    return other ? `Redan kopplad till ${title(other.label)}` : null;
  };
  const names = [...new Set([...participants, ...draft.map((row) => row.name?.trim()).filter((n): n is string => Boolean(n))])];

  async function save() {
    const found: Record<string, string> = {};
    for (const row of draft) {
      const problem = speakerNameProblem(row.name);
      if (problem) found[row.label] = problem;
    }
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setRefusal(null);
    const refused = await onSave(draft.map((row) => ({ ...row, name: row.name?.trim() ? row.name.trim() : null })));
    setSaving(false);
    if (refused) setRefusal(refused);
    else setOpen(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setDraft([...rows]);
          setProblems({});
          setRefusal(null);
        }
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        className="flex max-h-[min(90dvh,48rem)] max-w-2xl flex-col gap-0 p-0 max-sm:inset-x-0 max-sm:top-0 max-sm:h-[var(--visible-height,100dvh)] max-sm:max-h-none max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-0"
        style={height ? ({ "--visible-height": `${height}px` } as React.CSSProperties) : undefined}
      >
        <DialogHeader className="border-b border-border px-6 pb-4 pt-6 pr-14 text-left">
          <DialogTitle>Namnge talarna</DialogTitle>
          <DialogDescription>
            Lyssna på ett exempel och välj vem som talar. Namnen skrivs in i transkriptet och dokumentet när du fortsätter.
          </DialogDescription>
        </DialogHeader>
        <ul className="min-h-0 flex-1 overflow-y-auto px-6 [&_input]:scroll-my-3">
          {draft.map((row) => {
            const count = passages(row.label);
            const said = quote(row.label);
            const unavailable = listenUnavailableReason?.(row.label) ?? null;
            return (
              <li key={row.label} className="flex flex-col gap-3 border-b border-border py-4 last:border-0 sm:flex-row sm:items-start">
                <div className="flex min-w-0 flex-1 gap-3">
                  <SpeakerMark label={row.label} name={title(row.label)} className="size-9 text-[13px]" />
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="text-[15px] font-medium text-ink">
                      {title(row.label)}
                      <span className="font-normal text-ink-mute"> · {count} inlägg</span>
                    </p>
                    {said && <p className="line-clamp-2 text-[14px] text-ink-soft">”{said}”</p>}
                    {onListen && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="-ml-2 self-start"
                        disabled={disabled || Boolean(unavailable)}
                        title={unavailable ?? undefined}
                        aria-label={`Lyssna på exempel: ${title(row.label)}`}
                        onClick={() => onListen(row.label)}
                      >
                        <Headphones data-icon="inline-start" aria-hidden />
                        Lyssna på exempel
                      </Button>
                    )}
                  </div>
                </div>
                <div className="flex flex-col gap-1 sm:w-64 sm:shrink-0">
                  <NameCombobox
                    aria-label={`Vem är ${title(row.label)}?`}
                    value={row.name}
                    options={names}
                    disabled={disabled || saving}
                    placeholder="Välj eller skriv ett namn"
                    noneLabel="Inget namn (behåll etiketten)"
                    writeLabel="Skriv ett annat namn"
                    optionNote={(name) => usedBy(name, row.label)}
                    onChange={(name) => setDraft((all) => all.map((r) => (r.label === row.label ? { ...r, name } : r)))}
                  />
                  {problems[row.label] && (
                    <p role="alert" className="text-[13px] text-destructive">
                      {problems[row.label]}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {refusal && (
          <p role="alert" className="border-t border-border px-6 py-3 text-[14px] text-destructive">
            {refusal}
          </p>
        )}
        <div className="flex justify-end gap-2 border-t border-border px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              Avbryt
            </Button>
          </DialogClose>
          <Button type="button" disabled={disabled || saving} onClick={() => void save()}>
            {saving ? "Sparar…" : "Spara namnen"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
