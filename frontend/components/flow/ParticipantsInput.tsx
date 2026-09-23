"use client";

import { X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { addNames, splitNames, takeNames } from "@/lib/participants";
import { cn } from "@/lib/utils";

/**
 * A `list` field as chips: Enter or a comma adds the name, a pasted list is
 * split on commas, semicolons and line breaks, Backspace in the empty input
 * removes the last chip, and each chip has its own remove button. Earlier
 * names are offered as the browser's own suggestions. Text left in the input
 * becomes a chip when the field loses focus, so a typed name is never lost.
 */
export function ParticipantsInput({
  id,
  names,
  onChange,
  suggestions,
  onAdded,
  describedBy,
  invalid,
  placeholder = "Lägg till namn",
}: {
  id: string;
  names: string[];
  onChange: (names: string[]) => void;
  suggestions: string[];
  /** Names the user just added, to offer them again next time. */
  onAdded?: (names: string[]) => void;
  describedBy?: string;
  invalid?: boolean;
  placeholder?: string;
}) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [announcement, setAnnouncement] = useState("");

  function add(added: string[]) {
    const next = addNames(names, added);
    const fresh = next.slice(names.length);
    if (fresh.length === 0) return;
    onChange(next);
    onAdded?.(fresh);
    setAnnouncement(fresh.length === 1 ? `${fresh[0]} har lagts till.` : `${fresh.length} namn har lagts till.`);
  }

  function remove(name: string) {
    onChange(names.filter((existing) => existing !== name));
    setAnnouncement(`${name} har tagits bort.`);
  }

  const offered = suggestions.filter(
    (suggestion) => !names.some((name) => name.toLowerCase() === suggestion.toLowerCase()),
  );

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-xl border border-rule bg-paper px-3 py-2 transition-colors",
        "focus-within:border-primary focus-within:ring-1 focus-within:ring-primary",
        invalid && "border-destructive",
      )}
    >
      {names.length > 0 && (
        <ul className="flex flex-wrap gap-x-2 gap-y-3 pt-1.5">
          {names.map((name) => (
            <li
              key={name}
              className="inline-flex h-8 max-w-full items-center gap-0.5 rounded-lg bg-bg-2 pl-3 pr-0.5 text-[15px] text-ink"
            >
              <span className="truncate">{name}</span>
              <button
                type="button"
                aria-label={`Ta bort ${name}`}
                onClick={() => {
                  remove(name);
                  input.current?.focus();
                }}
                // The pseudo-element makes the target 44 px without a 44 px chip.
                className="relative grid size-7 shrink-0 place-items-center rounded-md text-ink-soft transition-colors hover:bg-rule-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary after:absolute after:-inset-2"
              >
                <X aria-hidden className="size-4" strokeWidth={2} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={input}
        id={id}
        type="text"
        value={text}
        list={offered.length > 0 ? listId : undefined}
        autoComplete="off"
        autoCapitalize="words"
        enterKeyHint="enter"
        placeholder={placeholder}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          const value = event.target.value;
          const picked =
            (event.nativeEvent as InputEvent).inputType === "insertReplacementText" &&
            offered.some((suggestion) => suggestion.toLowerCase() === value.trim().toLowerCase());
          if (picked) {
            add([value.trim()]);
            setText("");
            return;
          }
          const { names: complete, rest } = takeNames(value);
          if (complete.length > 0) add(complete);
          setText(rest.trimStart());
        }}
        onPaste={(event) => {
          // A single-line input drops line breaks, so split the pasted list here.
          const pasted = event.clipboardData.getData("text");
          if (!/[,;\n\r]/.test(pasted)) return;
          event.preventDefault();
          add(splitNames(text + pasted));
          setText("");
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            add(splitNames(text));
            setText("");
          } else if (event.key === "Backspace" && text === "" && names.length > 0) {
            event.preventDefault();
            remove(names[names.length - 1]);
          }
        }}
        onBlur={() => {
          if (!text.trim()) return;
          add(splitNames(text));
          setText("");
        }}
        className="h-9 w-full min-w-0 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-mute"
      />
      {offered.length > 0 && (
        <datalist id={listId}>
          {offered.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      )}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
