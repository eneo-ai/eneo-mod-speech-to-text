import { cloneElement, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactElement, type MouseEvent, type Ref } from "react";
import { Headphones, Pause } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { ActionRow } from "@/components/ActionRow";
import { useSignedOut } from "@/components/AuthGate";
import { NameCombobox } from "@/components/NameCombobox";
import styles from "@/components/SpeakerNamingDialog.module.css";
import { SpeakerMark } from "@/components/SpeakerMark";
import { browserStorage } from "@/lib/browser-storage";
import { browserDrafts, clearDraft, readDraft, writeDraft } from "@/lib/drafts";
import { recentNames, rememberNames } from "@/lib/participants";
import { isRecord } from "@/lib/is-record";
import { isUnsureProposal, type SpeakerMappingRow } from "@/lib/speaker-mapping";
import { speakerDisplayLabel, speakerNameProblem } from "@/lib/transcript";

/**
 * The keyboard on a phone covers the lower part of the screen without making
 * the page shorter, and the browser moves the part that is visible to keep the
 * field being typed in sight; the dialog follows that part, its height and its
 * top, so the title, the focused field and the actions stay in reach.
 */
function useVisibleViewport(active: boolean): { height: number; top: number } | null {
  const [visible, setVisible] = useState<{ height: number; top: number } | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!active || !viewport) return;
    const update = () => setVisible({ height: viewport.height, top: viewport.offsetTop ?? 0 });
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    // Some browsers shrink the page itself for the keyboard instead.
    window.addEventListener("resize", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [active]);
  // Once the dialog has its new height, the field being typed in stays in sight above the keyboard.
  const height = visible?.height ?? null;
  useEffect(() => {
    const focused = document.activeElement;
    if (height && focused instanceof HTMLElement && focused.closest("dialog")) focused.scrollIntoView({ block: "nearest" });
  }, [height]);
  return visible;
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

/** Opens the dialog from elsewhere than its button: at one speaker's name, and gives the focus to `returnTo` when it closes. */
export type SpeakerNamingHandle = { open: (label: string, returnTo: HTMLElement | null) => void };

/**
 * "Namnge talarna": one row per speaker with a sample to listen to, the first
 * thing they say, how many passages they have, and a name picked from the
 * participants or typed. "Spara namnen" saves the names and closes the dialog.
 * At the review pause it saves the pause's edit, which is what reaches the
 * transcript and the document, and only names: the flow goes on from the page's
 * own "Godkänn och fortsätt". After the run it saves the names with the
 * transcript's corrections.
 */
export function SpeakerNamingDialog({
  ref,
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
  decided = false,
  draftKey,
  description = "Lyssna på ett exempel och välj vem som talar.",
  children,
}: {
  ref?: Ref<SpeakerNamingHandle>;
  rows: readonly SpeakerMappingRow[];
  /** What the mapping step proposed for each speaker: its name, how sure it was and why. */
  proposals?: readonly SpeakerMappingRow[];
  /**
   * The names entered before the run: suggestions, never assumed. A run started without any offers the names this person
   * gave before (lib/participants.ts recentNames), and a save adds the names given to them.
   */
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
  /** The pause is approved: the saved names (`rows`) are shown read-only, and the one action is Stäng. */
  decided?: boolean;
  /** Keeps names typed but not saved for this person through a reload, the dialog open again with them. */
  draftKey?: { ownerId: string; name: string };
  /** What naming changes, under the title: the review's words unless the page has its own. */
  description?: string;
  /** The button that opens the dialog; focus returns to it on close. */
  children: Trigger;
}) {
  // Names typed but not saved: kept through closing the dialog, by any of its ways out, and through a reload (it opens
  // again with them); saving them ends them.
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
  const [saving, setSaving] = useState(false);
  const visible = useVisibleViewport(shown);
  const height = visible?.height ?? null;
  // Less is visible than the window holds (the keyboard is open, or the page is zoomed in): the dialog stands at the top
  // of what is visible (SpeakerNamingDialog.module.css), where the middle of the window would put its title out of sight.
  const covered = visible !== null && visible.height < window.innerHeight - 1;
  const dialogElement = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    if (covered) dialogElement.current?.style.setProperty("--visible-top", `${visible.top}px`);
  }, [covered, visible?.top]);
  const descriptionId = useId();
  // A phone held upright gives the dialog the whole screen: room for more than one speaker under its title.
  const narrow = useMediaQuery("(max-width: 479.98px)");

  // Esc, Stäng, Avbryt or the ×: what was typed is there when it opens again.
  const close = () => {
    setOpen(false);
    onStopListening?.();
  };
  /** A save that went through: the dialog closes and what was typed is done with. */
  const end = () => {
    close();
    setTyped(null);
    if (draftKey) clearDraft(browserDrafts(), draftKey.ownerId, draftKey.name);
  };
  // Focus goes back to the button that opened the dialog, which the design system's own return cannot be trusted
  // with: a click leaves the focus on the page's body in Safari and Firefox on a Mac. Opened from elsewhere (a passage's
  // Ändra talare, which has closed), it goes back there.
  const trigger = useRef<HTMLElement | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) (returnTo.current ?? trigger.current)?.focus();
    wasOpen.current = open;
  }, [open]);
  // Opened at one speaker: once the dialog is open (its title has the focus), that speaker's name field takes it.
  const [startAt, setStartAt] = useState<string | null>(null);
  useEffect(() => {
    if (!shown || startAt === null) return;
    const row = [...(dialogElement.current?.querySelectorAll<HTMLElement>("li[data-speaker]") ?? [])].find((li) => li.dataset.speaker === startAt);
    row?.querySelector("input")?.focus();
    setStartAt(null);
  }, [shown, startAt]);
  useImperativeHandle(ref, () => ({
    open(label, from) {
      returnTo.current = from;
      setStartAt(label);
      setProblems({});
      setRefusal(null);
      setOpen(true);
    },
  }), []);

  // A name given to another speaker is said quietly; only the row's own choice is checked.
  const usedBy = (name: string, label: string) => {
    const other = draft.find((row) => row.label !== label && row.name?.trim() === name.trim());
    return other ? `Redan kopplad till ${speakerDisplayLabel(other.label)}` : null;
  };
  const ownerId = draftKey?.ownerId;
  const offered = participants.length > 0 || !ownerId ? participants : recentNames(browserStorage(), ownerId);
  const names = [...new Set([...offered, ...draft.map((row) => row.name?.trim()).filter((n): n is string => Boolean(n))])];

  /** Checks each name, then saves; a refusal keeps the dialog and the names as they are. */
  async function submit() {
    const found: Record<string, string> = {};
    for (const row of draft) {
      const problem = speakerNameProblem(row.name);
      if (problem) found[row.label] = problem;
    }
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setRefusal(null);
    const rows = draft.map((row) => ({ ...row, name: row.name?.trim() ? row.name.trim() : null }));
    const refused = await onSave(rows);
    setSaving(false);
    if (refused) return setRefusal(refused);
    if (ownerId) rememberNames(browserStorage(), ownerId, rows.flatMap((row) => (row.name ? [row.name] : [])));
    end();
  }

  return (
    <>
      {cloneElement(children, {
        ref: trigger,
        "aria-haspopup": "dialog",
        onClick: (event: MouseEvent<HTMLElement>) => {
          children.props.onClick?.(event);
          returnTo.current = null;
          setProblems({});
          setRefusal(null);
          setOpen(true);
        },
      })}
      {/* The design system's dialog renders its children closed too: the rows, and their lists, only while it is open. */}
      <Dialog
        ref={dialogElement}
        isOpen={shown}
        onOpenChange={(next) => !next && close()}
        purpose="form"
        variant={narrow ? "fullscreen" : "standard"}
        width="42rem"
        className={covered && !narrow ? styles.atVisibleTop : undefined}
        maxHeight={height ? `min(90dvh, 48rem, calc(${height}px - 2 * var(--spacing-4)))` : "min(90dvh, 48rem)"}
        aria-describedby={descriptionId}
      >
        <Layout
          header={<DialogHeader title="Namnge talarna" onOpenChange={() => close()} hasDivider />}
          content={
            <LayoutContent>
              <Text as="p" id={descriptionId} color="secondary">
                {description}
              </Text>
              {/* Tab past the last control comes back to the first without scrolling to it (the dialog's focus trap
                  moves focus with preventScroll), so the list brings whatever takes focus into view itself. */}
              {shown && (
                <ul className={styles.rows} onFocus={(e) => e.target.scrollIntoView({ block: "nearest" })}>
                  {draft.map((row) => {
                    const count = passages(row.label);
                    const said = quote(row.label);
                    const unavailable = listenUnavailableReason?.(row.label) ?? null;
                    const playing = listening === row.label;
                    const proposal = proposals.find((p) => p.label === row.label);
                    // The flow's own guess, still in the field, said to be one when it was not sure.
                    const unsure = isUnsureProposal(row, proposals);
                    const sample = playing ? "Stoppa exempel" : "Lyssna på exempel";
                    return (
                      <li key={row.label} className={styles.row} data-speaker={row.label}>
                        <div className={styles.who}>
                          {/* The mark the page has for this person: their initial once a name is chosen, as it is chosen. */}
                          <SpeakerMark label={row.label} name={row.name || speakerDisplayLabel(row.label)} size="lg" />
                          <VStack gap={1} hAlign="start" className={styles.said}>
                            <Text as="p">
                              <Text weight="medium">{speakerDisplayLabel(row.label)}</Text>
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
                                label={`${sample}: ${speakerDisplayLabel(row.label)}`}
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
                            label={`Vem är ${speakerDisplayLabel(row.label)}?`}
                            description={unsure ? "Osäkert förslag" : undefined}
                            value={row.name}
                            options={names}
                            disabled={disabled || decided || saving}
                            placeholder="Välj eller skriv ett namn"
                            noneLabel="Inget namn (behåll etiketten)"
                            writeLabel="Skriv ett annat namn"
                            optionNote={(name) => usedBy(name, row.label)}
                            problem={problems[row.label]}
                            onChange={(name) => rename(row.label, name)}
                          />
                          {/* A status, as on the page's list; the field says it to a screen reader. */}
                          {unsure && (
                            <HStack aria-hidden>
                              <Token size="sm" color="yellow" label="Osäkert förslag" icon={<Icon icon="warning" size="sm" />} />
                            </HStack>
                          )}
                          {proposal?.evidence && (
                            <Collapsible
                              className={styles.why}
                              defaultIsOpen={false}
                              chevronPosition="start"
                              trigger={<Text type="supporting" weight="medium">Varför?</Text>}
                            >
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
                {decided && <Text as="p" color="secondary">Namnen är redan sparade.</Text>}
                {/* On a phone's whole screen the title's × is the way out: the footer keeps to Spara namnen, and the
                    speakers have its room. */}
                <ActionRow>
                  {!decided && !narrow && <Button variant="ghost" label="Avbryt" onClick={close} />}
                  {decided ? (
                    <Button variant="secondary" label="Stäng" onClick={close} />
                  ) : (
                    <Button
                      variant="primary"
                      label={saving ? "Sparar…" : "Spara namnen"}
                      isDisabled={disabled || saving}
                      onClick={() => void submit()}
                    />
                  )}
                </ActionRow>
              </VStack>
            </LayoutFooter>
          }
        />
      </Dialog>
    </>
  );
}
