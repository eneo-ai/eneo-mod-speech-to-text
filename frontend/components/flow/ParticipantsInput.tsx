"use client";

import { Plus, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { addNames, splitNames, takeNames } from "@/lib/participants";
import { cn } from "@/lib/utils";

/**
 * A `list` field as chips. "Lägg till" shows while a name is typed, so a
 * tap adds it on any device; Enter (a phone's return key) or a comma adds it
 * too, a pasted list is split on commas, semicolons and line breaks,
 * Backspace in the empty input removes the last chip, and each chip has its
 * own remove button. Earlier names are offered as the browser's own
 * suggestions. Text left in the input becomes a chip when the field loses
 * focus, so a typed name is never lost.
 */
export function ParticipantsInput({
  id,
  names,
  onChange,
  suggestions,
  onAdded,
  describedBy,
  invalid,
  required,
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
  required?: boolean;
  placeholder?: string;
}) {
  const listId = useId();
  const countId = useId();
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

  const addTyped = () => {
    add(splitNames(text));
    setText("");
  };

  return (
    // Layout only: the list and the field carry their own names, so no unnamed groups around them.
    <InputGroup
      role="none"
      className={cn(
        // Sized by its content on every pointer, so "Lägg till" has the same room with names or without.
        "h-auto flex-col items-stretch rounded-xl border-rule bg-paper coarse:h-auto",
        // A 2 px ring: the edge turning blue alone is too small a change to see.
        "has-[[data-slot=input-group-control]:focus-visible]:border-primary has-[[data-slot=input-group-control]:focus-visible]:ring-2 has-[[data-slot=input-group-control]:focus-visible]:ring-primary",
        invalid && "border-destructive",
      )}
    >
      {names.length > 0 && (
        <InputGroupAddon role="none" align="block-start" className="cursor-default py-0 pt-3 text-foreground">
          <ul aria-label="Tillagda namn" className="flex flex-wrap gap-x-2 gap-y-3">
            {names.map((name) => (
              <li
                key={name}
                className="inline-flex h-8 max-w-full items-center gap-0.5 rounded-lg bg-bg-2 pl-3 pr-0.5 text-[15px] font-normal text-ink"
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
        </InputGroupAddon>
      )}
      <div
        className="flex w-full items-center"
        // Leaving the field and its "Lägg till" together adds what was typed; moving between them does not.
        onBlur={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null) || !text.trim()) return;
          addTyped();
        }}
      >
        <InputGroupInput
          ref={input}
          id={id}
          type="text"
          value={text}
          list={offered.length > 0 ? listId : undefined}
          autoComplete="off"
          autoCapitalize="words"
          enterKeyHint="enter"
          placeholder={placeholder}
          // The field says how many names it already holds; the list itself is named.
          aria-describedby={[names.length > 0 ? countId : null, describedBy].filter(Boolean).join(" ") || undefined}
          aria-invalid={invalid || undefined}
          aria-required={required || undefined}
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
              addTyped();
            } else if (event.key === "Backspace" && text === "" && names.length > 0) {
              event.preventDefault();
              remove(names[names.length - 1]);
            }
          }}
          className="px-3 text-[16px] text-ink placeholder:text-ink-mute"
        />
        {text.trim() && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="sm"
              variant="secondary"
              // Keeps the focus, and a phone's keyboard, in the field for the next name.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                addTyped();
                input.current?.focus();
              }}
              // The chips' height on every pointer; on a touch screen the pseudo-element makes the target 44 px.
              className="relative px-3 text-[15px] coarse:h-8 coarse:after:absolute coarse:after:-inset-1.5"
            >
              <Plus data-icon="inline-start" aria-hidden />
              Lägg till
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </div>
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
      {names.length > 0 && (
        // Hidden: read as the field's description only, not again as page text.
        <span id={countId} hidden>
          {names.length === 1 ? "1 namn tillagt." : `${names.length} namn tillagda.`}
        </span>
      )}
    </InputGroup>
  );
}
