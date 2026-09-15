"use client";

import { Check, ChevronDown, Plus, UserX } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const NONE_ID = "none";
const ADD_ID = "add";

type Option =
  | { id: string; kind: "name"; name: string }
  | { id: typeof ADD_ID; kind: "add"; name: string }
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
  "aria-label"?: string;
  className?: string;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
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
    out.push({ id: NONE_ID, kind: "none" });
    return out;
  }, [options, query, trimmed, exact, typing]);

  useEffect(() => {
    if (active >= items.length) setActive(Math.max(0, items.length - 1));
  }, [items.length, active]);

  // Stäng när fokus lämnar hela fältet (klick utanför, tabb).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function choose(option: Option) {
    if (option.kind === "none") onChange(null);
    else onChange(option.name);
    setTyping(false);
    setOpen(false);
    inputRef.current?.focus();
  }

  function openList() {
    setTyping(false);
    setOpen(true);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        openList();
        return;
      }
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + delta + items.length) % items.length);
    } else if (e.key === "Enter") {
      if (!open) return;
      e.preventDefault();
      const option = items[active];
      if (option) choose(option);
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, open, listId]);

  const activeId = open && items[active] ? `${listId}-${active}` : undefined;

  return (
    <div ref={rootRef} className={cn("relative min-w-0", className)}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
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
          setActive(0);
        }}
        onFocus={openList}
        onClick={openList}
        onKeyDown={onKeyDown}
        className="h-9 w-full min-w-0 rounded-md border border-rule bg-paper pl-2.5 pr-8 text-[13px] text-ink shadow-sm transition-colors placeholder:text-ink-mute focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-paper disabled:cursor-not-allowed disabled:opacity-50"
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={open ? "Stäng listan" : "Visa namn"}
        disabled={disabled}
        onClick={(e) => {
          // Låt inte inputens onFocus öppna listan igen direkt efter en stängning.
          e.preventDefault();
          const nextOpen = !open;
          inputRef.current?.focus();
          setTyping(false);
          setOpen(nextOpen);
        }}
        className="absolute inset-y-0 right-0 grid w-8 place-items-center text-ink-mute hover:text-ink disabled:opacity-50"
      >
        <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
      </button>

      <ul
        id={listId}
        role="listbox"
        aria-label={ariaLabel ? `Förslag: ${ariaLabel}` : "Namnförslag"}
        hidden={!open}
        className="absolute left-0 right-0 top-full z-50 mt-1 max-h-60 overflow-y-auto rounded-md border border-rule-soft bg-paper p-1 shadow-md"
      >
        {items.map((option, i) => {
          const selected =
            option.kind === "name" ? option.name === value : option.kind === "none" && value === null;
          return (
            <li
              key={option.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={selected}
              onMouseEnter={() => setActive(i)}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => choose(option)}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-[13px]",
                i === active ? "bg-bg-2 text-ink shadow-[inset_3px_0_0_hsl(var(--accent))]" : "text-ink",
                option.kind === "none" && "text-ink-soft",
                option.kind === "none" && items.length > 1 && "mt-1 border-t border-rule-soft pt-2",
              )}
            >
              {option.kind === "add" && <Plus className="h-3.5 w-3.5 shrink-0 text-accent" />}
              {option.kind === "none" && <UserX className="h-3.5 w-3.5 shrink-0" />}
              <span className="min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere]">
                {option.kind === "add" ? (
                  <>
                    Lägg till <span className="font-semibold">“{option.name}”</span>
                  </>
                ) : option.kind === "none" ? (
                  noneLabel
                ) : (
                  option.name
                )}
              </span>
              {selected && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
