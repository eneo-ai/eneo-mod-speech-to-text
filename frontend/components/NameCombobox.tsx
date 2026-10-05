import { Check, ChevronDown, Pencil, Plus, UserX } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { IconButton } from "@astryxdesign/core/IconButton";
import { usePopover } from "@astryxdesign/core/Popover";
import { TextInput } from "@astryxdesign/core/TextInput";
import styles from "@/components/NameCombobox.module.css";

const NONE_ID = "none";
const ADD_ID = "add";
const WRITE_ID = "write";

type Option =
  | { id: string; kind: "name"; name: string }
  | { id: typeof ADD_ID; kind: "add"; name: string }
  | { id: typeof WRITE_ID; kind: "write" }
  | { id: typeof NONE_ID; kind: "none" };

/**
 * A field that is both a list and free text: choose among known names or type a new one. The field's text is the
 * name itself, so every keystroke is a name, and "Lägg till" in the list only confirms what is there.
 *
 * The design system's Typeahead picks an item out of search hits; here the text in the field is the value, so the field
 * and the list are the module's own, built of the design system's input, icon button and surface (usePopover, as Typeahead).
 */
export function NameCombobox({
  value,
  options,
  onChange,
  disabled = false,
  placeholder,
  noneLabel,
  writeLabel,
  optionNote,
  label,
  problem,
}: {
  /** The chosen or typed name, or null for none. */
  value: string | null;
  /** The known names to choose among. */
  options: readonly string[];
  onChange: (name: string | null) => void;
  disabled?: boolean;
  placeholder: string;
  /** The row that clears the name, e.g. "Inget namn (behåll etiketten)". */
  noneLabel: string;
  /** Offers a way to type a name of one's own, e.g. "Skriv ett annat namn": it selects the field's text. */
  writeLabel?: string;
  /** A quiet note after a name, e.g. whom it is already given to; never a check. */
  optionNote?: (name: string) => string | null;
  /** The field's name, for a screen reader; the list's is "Förslag: <label>". */
  label: string;
  /** Why the name is refused, said under the field. */
  problem?: string;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The list is a popover in the top layer, anchored to the field: a dialog's scrolling body never cuts it off. The
  // focus stays in the field; a press outside the field and the list closes it (the browser's light dismiss), and
  // so does Escape, one layer at a time.
  const popover = usePopover({ hasCloseButton: false, hasAutoFocus: false, role: "none" });
  const open = popover.isOpen;
  const { triggerRef } = popover;
  useEffect(() => {
    triggerRef(rootRef.current);
    return () => triggerRef(null);
  }, [triggerRef]);
  // A name is no word to spell-check; the design system's input takes no spellCheck prop.
  useEffect(() => inputRef.current?.setAttribute("spellcheck", "false"), []);
  // The row the arrow keys or a moving pointer marked; until then the list marks the field's own name, so Enter
  // keeps what is in the field: a name opened by a click, and a name typed or pasted (never the first suggestion).
  const [moved, setMoved] = useState<number | null>(null);
  // The list is filtered only while the person types; opened by a click it shows every name, so another can be chosen.
  const [typing, setTyping] = useState(false);

  const text = value ?? "";
  const trimmed = text.trim();
  const query = trimmed.toLowerCase();
  const exact = options.some((n) => n.toLowerCase() === query);

  const items = useMemo<Option[]>(() => {
    const names =
      typing && query ? options.filter((n) => n.toLowerCase().includes(query)) : [...options];
    const out: Option[] = [...new Set(names)].map((name) => ({ id: `name:${name}`, kind: "name", name }));
    if (trimmed && !exact) {
      // A typed name that is not among the options: offered as an addition while it is typed, and shown as chosen when
      // the list is opened again.
      if (typing) out.push({ id: ADD_ID, kind: "add", name: trimmed });
      else out.unshift({ id: `name:${trimmed}`, kind: "name", name: trimmed });
    }
    if (writeLabel) out.push({ id: WRITE_ID, kind: "write" });
    out.push({ id: NONE_ID, kind: "none" });
    return out;
  }, [options, query, trimmed, exact, typing, writeLabel]);

  const isSelected = (option: Option) =>
    option.kind === "name" ? option.name === value : option.kind === "none" && value === null;
  // A row past the end (the last, or one the typing filtered away) is the last row.
  const active = moved === null ? items.findIndex(isSelected) : Math.min(moved, items.length - 1);

  function choose(option: Option) {
    if (option.kind === "write") {
      // What is typed next replaces the name.
      setTyping(true);
      popover.hide();
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    if (option.kind === "none") onChange(null);
    else onChange(option.name);
    setTyping(false);
    popover.hide();
    inputRef.current?.focus();
  }

  /** Opening by a click or the chevron marks the field's own name; an arrow key marks its end of the list. */
  function openList(marked: number | null = null) {
    setTyping(false);
    setMoved(marked);
    popover.show({ skipAutoFocus: true });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      if (!open) {
        openList(delta > 0 ? 0 : Number.POSITIVE_INFINITY);
        return;
      }
      setMoved(active < 0 ? (delta > 0 ? 0 : items.length - 1) : (active + delta + items.length) % items.length);
    } else if (e.key === "Enter") {
      if (!open) return;
      e.preventDefault();
      const option = items[active];
      if (option) choose(option);
      else popover.hide();
    } else if (e.key === "Tab") {
      // Closed here, not by the blur this press causes: a list hidden during the focus move makes the browser drop
      // the focus. Escape is the layer stack's: it closes the list and leaves a dialog around it open.
      popover.hide();
    }
  }

  // The marked row is brought into view when it becomes the marked one, and when the list itself mounts.
  const reveal = useCallback((row: HTMLLIElement | null) => row?.scrollIntoView({ block: "nearest" }), []);

  const activeId = open && active >= 0 && items[active] ? `${listId}-${active}` : undefined;

  return (
    <div ref={rootRef} className={styles.root}>
      <TextInput
        ref={inputRef}
        label={label}
        isLabelHidden
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        autoComplete="off"
        value={text}
        placeholder={placeholder}
        isDisabled={disabled}
        status={problem ? { type: "error", message: problem } : undefined}
        statusVariant="detached"
        className={styles.field}
        onChange={(next) => {
          onChange(next === "" ? null : next);
          setTyping(true);
          setMoved(null);
          popover.show({ skipAutoFocus: true });
        }}
        // Not on focus: a list that opens on every Tab covers the next field.
        onClick={() => openList()}
        onKeyDown={onKeyDown}
      />
      <IconButton
        variant="ghost"
        label={open ? "Stäng listan" : "Visa namn"}
        icon={<ChevronDown aria-hidden className={open ? styles.chevronOpen : styles.chevron} />}
        tabIndex={-1}
        isDisabled={disabled}
        className={styles.chevronButton}
        onClick={(e) => {
          e.preventDefault();
          const wasOpen = open;
          inputRef.current?.focus();
          if (wasOpen) popover.hide();
          else openList();
        }}
      />
      {popover.render(
        open ? (
          <ul id={listId} role="listbox" aria-label={`Förslag: ${label}`} className={styles.list}>
            {items.map((option, i) => {
              const selected = isSelected(option);
              const note = option.kind === "name" && !selected ? optionNote?.(option.name) : null;
              return (
                <li
                  key={option.id}
                  id={`${listId}-${i}`}
                  ref={i === active ? reveal : undefined}
                  role="option"
                  // The row Enter would take; the name in the field keeps its check beside it.
                  aria-selected={i === active}
                  data-kind={option.kind}
                  // A pointer that moves marks its row; a list opening under a resting one marks nothing.
                  onPointerMove={() => setMoved(i)}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => choose(option)}
                  className={styles.option}
                >
                  {option.kind === "add" && <Plus aria-hidden className={styles.optionIcon} />}
                  {option.kind === "write" && <Pencil aria-hidden className={styles.optionIcon} />}
                  {option.kind === "none" && <UserX aria-hidden className={styles.optionIcon} />}
                  <span className={styles.optionText}>
                    {option.kind === "add" ? (
                      <>
                        Lägg till <strong>“{option.name}”</strong>
                      </>
                    ) : option.kind === "none" ? (
                      noneLabel
                    ) : option.kind === "write" ? (
                      writeLabel
                    ) : (
                      option.name
                    )}
                  </span>
                  {note && <span className={styles.optionNote}>{note}</span>}
                  {selected && <Check aria-hidden className={styles.optionIcon} />}
                </li>
              );
            })}
          </ul>
        ) : null,
        { placement: "below", alignment: "start", offset: "var(--spacing-1)", className: styles.layer },
      )}
    </div>
  );
}
