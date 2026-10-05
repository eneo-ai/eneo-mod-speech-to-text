import { cloneElement, useEffect, useId, useRef, useState, type ReactElement, type MouseEvent } from "react";
import { Headphones, Pause } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useSignedOut } from "@/components/AuthGate";
import { NameCombobox } from "@/components/NameCombobox";
import styles from "@/components/SpeakerNamingDialog.module.css";
import { SpeakerMark } from "@/components/TranscriptPlayer";
import { browserDrafts, clearDraft, readDraft, writeDraft } from "@/lib/drafts";
import { isRecord } from "@/lib/is-record";
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
    if (height && focused instanceof HTMLElement && focused.closest("dialog")) focused.scrollIntoView({ block: "nearest" });
  }, [height]);
  return height;
}

/** The button that opens the dialog, whatever it is: it keeps its own props and gets the dialog's. */
type Trigger = ReactElement<{ onClick?: (event: MouseEvent<HTMLElement>) => void } & Record<string, unknown>>;

/** What the dialog takes from names kept earlier: for each speaker the label, and the name (null when it was taken away). */
type TypedName = Pick<SpeakerMappingRow, "label" | "name">;
const isNamesDraft = (value: unknown): value is TypedName[] =>
  Array.isArray(value) && value.every((row) => isRecord(row) && typeof row.label === "string" && (typeof row.name === "string" || row.name === null));

/** Names typed earlier, and kept for this person, wait to be shown: the dialog opens with them as it mounts. */
export const hasNamesDraft = (draftKey: { ownerId: string; name: string }) =>
  readDraft(browserDrafts(), draftKey.ownerId, draftKey.name, isNamesDraft) !== null;

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
  children: Trigger;
}) {
  // Names typed but not saved: kept through closing the dialog and through a reload (it opens again with them);
  // saving them or Avbryt ends them.
  const [typed, setTyped] = useState<TypedName[] | null>(() =>
    draftKey ? readDraft(browserDrafts(), draftKey.ownerId, draftKey.name, isNamesDraft) : null,
  );
  const [open, setOpen] = useState(() => typed !== null);
  // A native dialog stays above the cover of a page whose login has ended (a modal dialog's inertness is its own), so
  // it is closed while the login is: what was typed stays here, and the dialog is back with it after the new login.
  const signedOut = useSignedOut();
  const shown = open && !signedOut;
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
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState<"save" | "continue" | null>(null);
  const height = useVisibleHeight(shown);
  const descriptionId = useId();

  // Esc, Stäng or a click beside only close: what was typed is there when it opens again.
  const close = () => {
    setOpen(false);
    onStopListening?.();
  };
  /** Avbryt, and a save that went through: the dialog closes and what was typed is thrown away. */
  const end = () => {
    close();
    setTyped(null);
    if (draftKey) clearDraft(browserDrafts(), draftKey.ownerId, draftKey.name);
  };
  // Focus goes back to the button that opened the dialog, which the design system's own return cannot be trusted
  // with: a click leaves the focus on the page's body in Safari and Firefox on a Mac.
  const trigger = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);

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
    <>
      {cloneElement(children, {
        ref: trigger,
        "aria-haspopup": "dialog",
        onClick: (event: MouseEvent<HTMLElement>) => {
          children.props.onClick?.(event);
          setProblems({});
          setRefusal(null);
          setOpen(true);
        },
      })}
      {/* The design system's dialog renders its children closed too: the rows, and their lists, only while it is open. */}
      <Dialog
        isOpen={shown}
        onOpenChange={(next) => !next && close()}
        purpose="info"
        width="42rem"
        maxHeight={height ? `min(90dvh, 48rem, calc(${height}px - 2 * var(--spacing-4)))` : "min(90dvh, 48rem)"}
        aria-describedby={descriptionId}
      >
        <Layout
          header={<DialogHeader title="Namnge talarna" onOpenChange={() => close()} hasDivider />}
          content={
            <LayoutContent>
              <Text as="p" id={descriptionId} color="secondary">
                Lyssna på ett exempel och välj vem som talar. Namnen skrivs in i transkriptet och dokumentet när du fortsätter.
              </Text>
              {/* Tab past the last control comes back to the first without scrolling to it (the dialog's focus trap
                  moves focus with preventScroll), so the list brings whatever takes focus into view itself. */}
              {shown && (
                <ul className={styles.rows} onFocus={(e) => e.target.scrollIntoView?.({ block: "nearest" })}>
                  {draft.map((row) => {
                    const count = passages(row.label);
                    const said = quote(row.label);
                    const unavailable = listenUnavailableReason?.(row.label) ?? null;
                    const playing = listening === row.label;
                    const proposal = proposals.find((p) => p.label === row.label);
                    // The flow's own guess, still in the field, said to be one when it was not sure.
                    const unsure = Boolean(proposal?.name && row.name?.trim() === proposal.name.trim() && proposal.confidence !== "high");
                    const sample = playing ? "Stoppa exempel" : "Lyssna på exempel";
                    return (
                      <li key={row.label} className={styles.row}>
                        <div className={styles.who}>
                          <SpeakerMark label={row.label} name={title(row.label)} size="lg" />
                          <VStack gap={1} hAlign="start" className={styles.said}>
                            <Text as="p">
                              <Text weight="medium">{title(row.label)}</Text>
                              <Text color="secondary"> · {count} inlägg</Text>
                            </Text>
                            {said && (
                              <Text as="p" type="supporting" maxLines={2} hasTruncateTooltip={false}>
                                ”{said}”
                              </Text>
                            )}
                            {onListen && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className={styles.sample}
                                icon={playing ? <Pause aria-hidden /> : <Headphones aria-hidden />}
                                label={`${sample}: ${title(row.label)}`}
                                isDisabled={disabled || Boolean(unavailable)}
                                onClick={() => (playing ? onStopListening?.() : onListen(row.label))}
                              >
                                {sample}
                              </Button>
                            )}
                            {/* Said on the row, not only in a title a touch or keyboard user never sees. */}
                            {onListen && unavailable && <Text as="p" type="supporting">{unavailable}</Text>}
                          </VStack>
                        </div>
                        <div className={styles.name}>
                          <NameCombobox
                            label={`Vem är ${title(row.label)}?`}
                            value={row.name}
                            options={names}
                            disabled={disabled || decided || saving !== null}
                            placeholder="Välj eller skriv ett namn"
                            noneLabel="Inget namn (behåll etiketten)"
                            writeLabel="Skriv ett annat namn"
                            optionNote={(name) => usedBy(name, row.label)}
                            problem={problems[row.label]}
                            onChange={(name) => rename(row.label, name)}
                          />
                          {unsure && <Text as="p" type="supporting">Osäkert förslag</Text>}
                          {proposal?.evidence && (
                            <Collapsible defaultIsOpen={false} chevronPosition="start" trigger={<Text type="supporting" weight="medium">Varför?</Text>}>
                              <Text as="p" type="supporting">{proposal.evidence}</Text>
                            </Collapsible>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <VStack gap={3}>
                {refusal && <Banner status="error" title={refusal} collapsible={false} />}
                <HStack gap={2} wrap="wrap" hAlign="end" vAlign="center">
                  {decided && <Text as="p" color="secondary" className={styles.note}>Namnen är redan sparade.</Text>}
                  <Button variant="ghost" label="Avbryt" onClick={end} />
                  {!decided && (
                    <Button
                      variant="secondary"
                      label={saving === "save" ? "Sparar…" : "Spara"}
                      isDisabled={disabled || saving !== null}
                      onClick={() => void submit("save")}
                    />
                  )}
                  <Button
                    variant="primary"
                    label={saving === "continue" ? "Fortsätter…" : decided ? "Fortsätt" : "Spara och fortsätt"}
                    isDisabled={disabled || continueDisabled || saving !== null}
                    onClick={() => void submit("continue")}
                  />
                </HStack>
              </VStack>
            </LayoutFooter>
          }
        />
      </Dialog>
    </>
  );
}
