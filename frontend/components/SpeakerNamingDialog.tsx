import { cloneElement, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type MouseEvent, type Ref } from "react";
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

/** 12rem at the browser's default size: the dialog's title, one field and Spara namnen. */
const MIN_FOLLOWED_HEIGHT = 192;
/** 1rem at the browser's default size: what a field moved into sight keeps between itself and the keyboard. */
const ABOVE_KEYBOARD = 16;

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
  onUnsavedChange,
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
  /** Told whether names are typed and not saved, as that changes: the page asks before it goes on without them. */
  onUnsavedChange?: (unsaved: boolean) => void;
  /** What naming changes, under the title: the review's words unless the page has its own. */
  description?: string;
  /** The button that opens the dialog; focus returns to it on close. */
  children: Trigger;
}) {
  // Names typed but not saved: kept through closing the dialog by Esc or its ×, and through a reload (it opens again
  // with them); saving them ends them, and so does Avbryt, which says it.
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
  // Typed and not saved: a name in the dialog that differs from the saved one, the draft read back after a reload too.
  const unsaved = !decided && typed !== null && draft.some((row, index) => (row.name?.trim() || null) !== (rows[index]?.name?.trim() || null));
  useEffect(() => onUnsavedChange?.(unsaved), [unsaved]);
  const rename = (label: string, name: string | null) => {
    const next = draft.map((row) => (row.label === label ? { ...row, name } : row));
    setTyped(next);
    if (draftKey) writeDraft(browserDrafts(), draftKey.ownerId, draftKey.name, next);
  };
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Too little visible to hold a title, a field and an action (a phone on its side with the keyboard open): the dialog
  // keeps its own size, and the browser pans to the field as it does without the dialog following.
  const seen = useVisibleViewport(shown);
  const visible = seen && seen.height >= MIN_FOLLOWED_HEIGHT ? seen : null;
  const height = visible?.height ?? null;
  // Less is visible than the window holds (the keyboard is open, or the page is zoomed in): the dialog stands at the top
  // of what is visible (SpeakerNamingDialog.module.css), where the middle of the window would put its title out of sight.
  // The window is its layout's height: Safari can report innerHeight as the visible part's.
  const covered = visible !== null && visible.height < document.documentElement.clientHeight - 1;
  const dialogElement = useRef<HTMLDialogElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  // A phone held upright gives the dialog the whole screen: room for more than one speaker under its title.
  const narrow = useMediaQuery("(max-width: 479.98px)");
  // The whole screen ignores maxHeight, and the design system's size for it outranks a class: only the element's own
  // style makes it as tall as what the keyboard leaves, at its top, so the title, the field and Spara namnen show.
  const followed = (
    !covered ? undefined : narrow ? { top: visible.top, height: visible.height, maxHeight: visible.height } : { "--visible-top": `${visible.top}px` }
  ) as CSSProperties | undefined;
  // Too little visible to follow, and the field "Byt namn på" put the focus in is under the keyboard: Safari moves the
  // visible part to a field that is tapped, not to that one. The dialog then moves up, keeping its size, until the field
  // is above the keyboard, and back once the keyboard has closed. Only that field: a tapped one the browser shows itself,
  // a moment after the keyboard's first resize, and the dialog moved as well would take it off the top.
  const placed = useRef<HTMLElement | null>(null);
  const [lift, setLift] = useState(0);
  useLayoutEffect(() => {
    if (!shown) placed.current = null;
    if (!shown || !seen || seen.height >= MIN_FOLLOWED_HEIGHT) return setLift(0);
    const field = placed.current;
    if (seen.top > 0 || !field || document.activeElement !== field) return;
    // Measured where the dialog is, which the lift so far has moved.
    setLift((now) => Math.max(0, Math.ceil(field.getBoundingClientRect().bottom + now - seen.height + ABOVE_KEYBOARD)));
  }, [shown, seen?.height, seen?.top]);

  // Esc, Stäng or the ×: what was typed is there when it opens again.
  const close = () => {
    setOpen(false);
    onStopListening?.();
  };
  /** A save that went through, or Avbryt: the dialog closes and what was typed is done with. */
  const end = () => {
    close();
    setTyped(null);
    setSetAside([]);
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
  const fieldOf = (label: string) =>
    [...(dialogElement.current?.querySelectorAll<HTMLElement>("li[data-speaker]") ?? [])].find((li) => li.dataset.speaker === label)?.querySelector("input");
  useEffect(() => {
    if (!shown || startAt === null) return;
    const field = fieldOf(startAt) ?? null;
    placed.current = field;
    // Once the focus has left it, a tap brings it back, which the browser shows itself.
    field?.addEventListener("blur", () => placed.current === field && (placed.current = null), { once: true });
    field?.focus();
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
  // New names typed here and then replaced by a choice: still offered until the names are saved or thrown away.
  const [setAside, setSetAside] = useState<string[]>([]);
  const known = [...new Set([...offered, ...setAside])];
  const names = [...new Set([...known, ...draft.map((row) => row.name?.trim()).filter((n): n is string => Boolean(n))])];

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
        style={followed ?? (lift ? { translate: `0 -${lift}px` } : undefined)}
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
                  {draft.map((row, index) => {
                    const next = draft[index + 1];
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
                                icon={<Icon icon={playing ? Pause : Headphones} size="sm" />}
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
                            // The field's own text is no known name: typed, it is offered to add.
                            options={names.filter((name) => name !== row.name?.trim() || known.includes(name))}
                            disabled={disabled || decided || saving}
                            placeholder="Välj eller skriv ett namn"
                            noneLabel="Inget namn (behåll etiketten)"
                            writeLabel="Skriv ett annat namn"
                            optionNote={(name) => usedBy(name, row.label)}
                            problem={problems[row.label]}
                            onChange={(name) => rename(row.label, name)}
                            onSetAside={(name) => setSetAside((now) => [...now, name])}
                            // Enter goes on to the next speaker; after the last, to Spara namnen, which closes a
                            // phone's keyboard and saves nothing by itself, so a stray Enter sends no names.
                            enterKeyHint={next ? "next" : "done"}
                            onEnter={() => (next ? fieldOf(next.label) : saveButton.current)?.focus()}
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
                  {!decided && !narrow && <Button variant="ghost" label="Avbryt" onClick={end} />}
                  {decided ? (
                    <Button variant="secondary" label="Stäng" onClick={close} />
                  ) : (
                    <Button
                      ref={saveButton}
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
