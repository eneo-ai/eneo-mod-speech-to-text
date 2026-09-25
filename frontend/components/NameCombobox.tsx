"use client";

import { Check, ChevronDown, Pencil, Plus, UserX } from "lucide-react";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const NONE_ID = "none";
const ADD_ID = "add";
const WRITE_ID = "write";

type Option =
  | { id: string; kind: "name"; name: string }
  | { id: typeof ADD_ID; kind: "add"; name: string }
  | { id: typeof WRITE_ID; kind: "write" }
  | { id: typeof NONE_ID; kind: "none" };

/**
 * Ett fält som både är rullista och fritext: välj bland kända namn eller
 * skriv ett nytt. Fältets text är namnet självt — varje tangenttryckning
 * blir ett namn, så "Lägg till" i listan bekräftar bara det som står.
 */
export function NameCombobox({
  value,
  options,
  onChange,
  disabled = false,
  placeholder = "Välj eller skriv namn",
  noneLabel = "Ingen (behåll etiketten)",
  writeLabel,
  optionNote,
  "aria-label": ariaLabel,
  className,
}: {
  /** Valt/skrivet namn, eller null för "ingen". */
  value: string | null;
  /** Kända namn att välja bland. */
  options: readonly string[];
  onChange: (name: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
  noneLabel?: string;
  /** Offers a way to type a name of one's own, e.g. "Skriv ett annat namn": it selects the field's text. */
  writeLabel?: string;
  /** A quiet note after a name, e.g. whom it is already given to; never a check. */
  optionNote?: (name: string) => string | null;
  "aria-label"?: string;
  className?: string;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  // The row the arrow keys or the pointer moved to; until then the list marks the field's own name, so Enter
  // on a list opened by a click keeps it (it never picks the first name).
  const [moved, setMoved] = useState<number | null>(null);
  // Listan filtreras bara medan användaren skriver; öppnad med klick visar
  // den alla namn så att ett annat går att välja.
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
      // Ett skrivet namn som inte finns bland alternativen: erbjud det som
      // tillägg medan det skrivs, visa det som valt när listan öppnas igen.
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
      setOpen(false);
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    if (option.kind === "none") onChange(null);
    else onChange(option.name);
    setTyping(false);
    setOpen(false);
    inputRef.current?.focus();
  }

  /** Opening by a click, the chevron or focus marks the field's own name; an arrow key marks its end of the list. */
  function openList(marked: number | null = null) {
    setTyping(false);
    setMoved(marked);
    setOpen(true);
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
      else setOpen(false);
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  // The marked row is brought into view when it becomes the marked one, and when the list itself mounts.
  const reveal = useCallback((row: HTMLLIElement | null) => row?.scrollIntoView({ block: "nearest" }), []);

  const activeId = open && active >= 0 && items[active] ? `${listId}-${active}` : undefined;

  // The list floats over the page in its own layer, so a dialog's scrolling body never cuts it off;
  // the focus stays in the field, and a press outside the field and the list closes it. It closes at
  // once, without the fade: Tab moves on as it closes, and a fading list would cover the next control.
  return (
    <Popover open={open} onOpenChange={(next) => !next && setOpen(false)}>
    <PopoverAnchor asChild>
    <div ref={rootRef} className={cn("relative min-w-0", className)}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        autoComplete="off"
        spellCheck={false}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value;
          onChange(next === "" ? null : next);
          setTyping(true);
          setOpen(true);
          setMoved(0);
        }}
        onFocus={() => openList()}
        onClick={() => openList()}
        onKeyDown={onKeyDown}
        className="h-9 w-full min-w-0 rounded-md border border-rule bg-paper pl-2.5 pr-8 text-[13px] coarse:h-11 coarse:pr-11 coarse:text-base text-ink shadow-sm transition-colors placeholder:text-ink-mute focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-paper disabled:cursor-not-allowed disabled:opacity-50"
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={open ? "Stäng listan" : "Visa namn"}
        disabled={disabled}
        onClick={(e) => {
          // Låt inte inputens onFocus öppna listan igen direkt efter en stängning.
          e.preventDefault();
          const wasOpen = open;
          inputRef.current?.focus();
          if (wasOpen) setOpen(false);
          else openList();
        }}
        className="absolute inset-y-0 right-0 grid w-8 place-items-center coarse:w-11 text-ink-mute hover:text-ink disabled:opacity-50"
      >
        <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
      </button>
    </div>
    </PopoverAnchor>
    <PopoverContent
      align="start"
      sideOffset={4}
      role="presentation"
      onOpenAutoFocus={(e) => e.preventDefault()}
      onCloseAutoFocus={(e) => e.preventDefault()}
      onInteractOutside={(e) => {
        if (rootRef.current?.contains(e.target as Node)) e.preventDefault();
      }}
      className="max-h-60 w-[var(--radix-popper-anchor-width)] min-w-[12rem] overflow-y-auto rounded-md p-1 data-[state=closed]:!animate-none"
    >
      <ul
        id={listId}
        role="listbox"
        aria-label={ariaLabel ? `Förslag: ${ariaLabel}` : "Namnförslag"}
      >
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
              onMouseEnter={() => setMoved(i)}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => choose(option)}
              className={cn(
                "flex min-h-8 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] coarse:min-h-11 coarse:text-base",
                i === active ? "bg-bg-2 text-ink shadow-[inset_3px_0_0_hsl(var(--primary))]" : "text-ink",
                option.kind === "none" && "text-ink-soft",
                option.kind === "none" && items.length > 1 && "mt-1 border-t border-rule-soft pt-2",
              )}
            >
              {option.kind === "add" && <Plus className="h-3.5 w-3.5 shrink-0 text-primary" />}
              {option.kind === "write" && <Pencil className="h-3.5 w-3.5 shrink-0 text-ink-soft" />}
              {option.kind === "none" && <UserX className="h-3.5 w-3.5 shrink-0" />}
              <span className="min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere]">
                {option.kind === "add" ? (
                  <>
                    Lägg till <span className="font-semibold">“{option.name}”</span>
                  </>
                ) : option.kind === "none" ? (
                  noneLabel
                ) : option.kind === "write" ? (
                  writeLabel
                ) : (
                  option.name
                )}
              </span>
              {note && <span className="shrink-0 text-[12px] text-ink-mute">{note}</span>}
              {selected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
            </li>
          );
        })}
      </ul>
    </PopoverContent>
    </Popover>
  );
}
