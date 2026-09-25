"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, Headphones, Pause } from "lucide-react";
import { NameCombobox } from "@/components/NameCombobox";
import { SpeakerMark } from "@/components/TranscriptPlayer";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { browserDrafts, clearDraft, readDraft, writeDraft } from "@/lib/drafts";
import { speakerNameProblem, type SpeakerMappingRow } from "@/lib/speaker-mapping";
import { speakerDisplayLabel } from "@/lib/transcript";

/**
 * The keyboard on a phone covers the lower part of the screen without making
 * the page shorter; the dialog follows the visible part, so the focused field
 * and the actions stay in reach.
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
 * which is what reaches the transcript and the document. "Spara och fortsätt"
 * also lets the flow go on; "Spara" keeps the pause for later.
 */
export function SpeakerNamingDialog({
  rows,
  proposals = [],
  participants,
  passages,
  quote,
  disabled = false,
  onListen,
  listening = null,
  onStopListening,
  listenUnavailableReason,
  onSave,
  onSaveAndContinue,
  continueDisabled = false,
  decided = false,
  draftKey,
  children,
}: {
  rows: readonly SpeakerMappingRow[];
  /** What the mapping step proposed for each speaker: its name, how sure it was and why. */
  proposals?: readonly SpeakerMappingRow[];
  /** The names entered before the run: suggestions, never assumed. */
  participants: readonly string[];
  /** How many passages a speaker has in the transcript. */
  passages: (label: string) => number;
  /** The first thing a speaker says, quoted in the row. */
  quote: (label: string) => string | null;
  disabled?: boolean;
  /** Plays a short sample of the speaker through the page's one player. */
  onListen?: (label: string) => void;
  /** The speaker whose sample plays now. */
  listening?: string | null;
  /** Stops a sample that plays: on Stoppa exempel, and whenever the dialog closes. */
  onStopListening?: () => void;
  listenUnavailableReason?: (label: string) => string | null;
  /** Saves the names; returns why they were not saved, or null. */
  onSave: (rows: SpeakerMappingRow[]) => Promise<string | null>;
  /** Saves the names and lets the flow go on (approve and resume); returns why it did not, or null. */
  onSaveAndContinue: (rows: SpeakerMappingRow[]) => Promise<string | null>;
  /** The flow cannot go on yet (the transcript's own changes are still being saved); saving can. */
  continueDisabled?: boolean;
  /** The pause is approved: the saved names (`rows`) are shown read-only, and the one action is Fortsätt. */
  decided?: boolean;
  /** Keeps names typed but not saved for this person through a reload, the dialog open again with them. */
  draftKey?: { ownerId: string; name: string };
  /** The button that opens the dialog; focus returns to it on close. */
  children: ReactNode;
}) {
  // Names typed but not saved: kept through closing the dialog and through a reload (it opens again with them);
  // saving them or Avbryt ends them.
  const [typed, setTyped] = useState<SpeakerMappingRow[] | null>(() =>
    draftKey ? readDraft<SpeakerMappingRow[]>(browserDrafts(), draftKey.ownerId, draftKey.name) : null,
  );
  const [open, setOpen] = useState(() => typed !== null);
  // On the speakers there are now. Approved, what was saved is the decision: typed names are no longer the
  // dialog's to show or keep.
  const draft =
    decided || !typed
      ? [...rows]
      : rows.map((row) => {
          // A name taken away (null) stays taken away; only a speaker the draft has no row for keeps the review's.
          const kept = typed.find((name) => name.label === row.label);
          return kept ? { ...row, name: kept.name } : row;
        });
  useEffect(() => {
    if (decided && draftKey) clearDraft(browserDrafts(), draftKey.ownerId, draftKey.name);
  }, [decided, draftKey?.ownerId, draftKey?.name]);
  const rename = (label: string, name: string | null) => {
    const next = draft.map((row) => (row.label === label ? { ...row, name } : row));
    setTyped(next);
    if (draftKey) writeDraft(browserDrafts(), draftKey.ownerId, draftKey.name, next);
  };
  const end = () => {
    setOpen(false);
    onStopListening?.();
    setTyped(null);
    if (draftKey) clearDraft(browserDrafts(), draftKey.ownerId, draftKey.name);
  };
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState<"save" | "continue" | null>(null);
  const height = useVisibleHeight(open);

  const title = (label: string) => speakerDisplayLabel(label);
  // A name given to another speaker is said quietly; only the row's own choice is checked.
  const usedBy = (name: string, label: string) => {
    const other = draft.find((row) => row.label !== label && row.name?.trim() === name.trim());
    return other ? `Redan kopplad till ${title(other.label)}` : null;
  };
  const names = [...new Set([...participants, ...draft.map((row) => row.name?.trim()).filter((n): n is string => Boolean(n))])];

  /** Checks each name, then saves (and goes on); a refusal keeps the dialog and the names as they are. */
  async function submit(action: "save" | "continue") {
    const found: Record<string, string> = {};
    for (const row of draft) {
      const problem = speakerNameProblem(row.name);
      if (problem) found[row.label] = problem;
    }
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    setSaving(action);
    setRefusal(null);
    const rows = draft.map((row) => ({ ...row, name: row.name?.trim() ? row.name.trim() : null }));
    const refused = await (action === "save" ? onSave : onSaveAndContinue)(rows);
    setSaving(null);
    if (refused) setRefusal(refused);
    else end();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Esc, Stäng or a click beside only close: what was typed is there when it opens again.
        setOpen(next);
        if (!next) return onStopListening?.();
        setProblems({});
        setRefusal(null);
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
        {/* Tab past the last control comes back to the first without scrolling to it (the dialog's focus trap
            moves focus with preventScroll), so the list brings whatever takes focus into view itself. */}
        <ul
          className="min-h-0 flex-1 overflow-y-auto px-6 [&_input]:scroll-my-3"
          onFocus={(e) => e.target.scrollIntoView?.({ block: "nearest" })}
        >
          {draft.map((row) => {
            const count = passages(row.label);
            const said = quote(row.label);
            const unavailable = listenUnavailableReason?.(row.label) ?? null;
            const playing = listening === row.label;
            const proposal = proposals.find((p) => p.label === row.label);
            // The flow's own guess, still in the field, said to be one when it was not sure.
            const unsure = Boolean(proposal?.name && row.name?.trim() === proposal.name.trim() && proposal.confidence !== "high");
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
                        aria-label={`${playing ? "Stoppa exempel" : "Lyssna på exempel"}: ${title(row.label)}`}
                        onClick={() => (playing ? onStopListening?.() : onListen(row.label))}
                      >
                        {playing ? <Pause data-icon="inline-start" aria-hidden /> : <Headphones data-icon="inline-start" aria-hidden />}
                        {playing ? "Stoppa exempel" : "Lyssna på exempel"}
                      </Button>
                    )}
                    {/* Said on the row, not only in a title a touch or keyboard user never sees. */}
                    {onListen && unavailable && <p className="text-[13px] text-ink-mute">{unavailable}</p>}
                  </div>
                </div>
                <div className="flex flex-col gap-1 sm:w-64 sm:shrink-0">
                  <NameCombobox
                    aria-label={`Vem är ${title(row.label)}?`}
                    value={row.name}
                    options={names}
                    disabled={disabled || decided || saving !== null}
                    placeholder="Välj eller skriv ett namn"
                    noneLabel="Inget namn (behåll etiketten)"
                    writeLabel="Skriv ett annat namn"
                    optionNote={(name) => usedBy(name, row.label)}
                    onChange={(name) => rename(row.label, name)}
                  />
                  {unsure && <p className="text-[13px] text-ink-mute">Osäkert förslag</p>}
                  {problems[row.label] && (
                    <p role="alert" className="text-[13px] text-destructive">
                      {problems[row.label]}
                    </p>
                  )}
                  {proposal?.evidence && (
                    <Collapsible>
                      <CollapsibleTrigger asChild>
                        <Button type="button" variant="ghost" size="sm" className="group -ml-2 self-start text-ink-soft">
                          Varför?
                          <ChevronDown
                            data-icon="inline-end"
                            aria-hidden
                            className="transition-transform duration-150 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
                          />
                        </Button>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <p className="text-[13px] text-ink-soft">{proposal.evidence}</p>
                      </CollapsibleContent>
                    </Collapsible>
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
        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {decided && <p className="mr-auto self-center text-[14px] text-ink-soft">Namnen är redan sparade.</p>}
          <DialogClose asChild>
            <Button type="button" variant="ghost" onClick={end}>
              Avbryt
            </Button>
          </DialogClose>
          {!decided && (
            <Button type="button" variant="outline" disabled={disabled || saving !== null} onClick={() => void submit("save")}>
              {saving === "save" ? "Sparar…" : "Spara"}
            </Button>
          )}
          <Button type="button" disabled={disabled || continueDisabled || saving !== null} onClick={() => void submit("continue")}>
            {saving === "continue" ? "Fortsätter…" : decided ? "Fortsätt" : "Spara och fortsätt"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
