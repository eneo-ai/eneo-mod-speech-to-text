"use client";

import { Plus } from "lucide-react";
import { useId, useRef, useState, type FocusEvent } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { addNames, splitNames, takeNames } from "@/lib/participants";

// What the field needs of the browser that the design system's types leave out (the input spreads what it does not
// know onto the element, so it works): the page's own suggestions, a capital for each name and the return key's label.
const hints = (listId: string | undefined) =>
  ({ list: listId, autoCapitalize: "words", enterKeyHint: "enter" }) as Record<string, string | undefined>;

/**
 * A `list` field as names. "Lägg till" shows while a name is typed, so a
 * tap adds it on any device; Enter (a phone's return key) or a comma adds it
 * too, a pasted list is split on commas, semicolons and line breaks,
 * Backspace in the empty input removes the last name, and each name has its
 * own remove button. Earlier names are offered as the browser's own
 * suggestions. Text left in the input becomes a name when the field loses
 * focus, so a typed name is never lost.
 *
 * Kept as ours, not the design system's Tokenizer, which needs a search source, has no paste splitting, no comma
 * and no add-on-blur, no "Lägg till", and offers its "Create" entry in English.
 */
export function ParticipantsInput({
  label,
  name,
  names,
  onChange,
  suggestions,
  onAdded,
  description,
  isOptional,
  isRequired,
  status,
  placeholder = "Lägg till namn",
}: {
  label: string;
  /** The detail's name, which the page finds the field by to move focus to it. */
  name?: string;
  names: string[];
  onChange: (names: string[]) => void;
  suggestions: string[];
  /** Names the user just added, to offer them again next time. */
  onAdded?: (names: string[]) => void;
  /** What the field is for, said under its label. */
  description?: string;
  isOptional?: boolean;
  isRequired?: boolean;
  /** Said at the field: the list is required and empty. */
  status?: { type: "error"; message: string };
  placeholder?: string;
}) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
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

  function remove(removed: string) {
    onChange(names.filter((existing) => existing !== removed));
    setAnnouncement(`${removed} har tagits bort.`);
  }

  const offered = suggestions.filter(
    (suggestion) => !names.some((existing) => existing.toLowerCase() === suggestion.toLowerCase()),
  );

  const addTyped = () => {
    add(splitNames(text));
    setText("");
  };

  // Leaving the field and its "Lägg till" together adds what was typed; moving between them does not.
  const leaving = (event: FocusEvent) => {
    const to = event.relatedTarget;
    if (!text.trim() || to === input.current || to === addButton.current) return;
    addTyped();
  };

  // The field says how many names it already holds; the list itself is named.
  const count = names.length === 1 ? "1 namn tillagt." : `${names.length} namn tillagda.`;

  return (
    <VStack gap={2}>
      {/* The button beside the field, not inside it: the design system's field names its label and says whether it is
          required once, which a group around it would do twice. */}
      <HStack gap={2} align="end">
        <TextInput
          ref={input}
          label={label}
          description={[description, names.length > 0 ? count : null].filter(Boolean).join(" ") || undefined}
          isOptional={isOptional}
          isRequired={isRequired}
          status={status}
          statusVariant="detached"
          value={text}
          placeholder={placeholder}
          autoComplete="off"
          width="100%"
          data-detail-field={name}
          {...hints(offered.length > 0 ? listId : undefined)}
          onBlur={leaving}
          onChange={(value, event) => {
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
        />
        {text.trim() && (
          <Button
            ref={addButton}
            label="Lägg till"
            icon={<Icon icon={Plus} />}
            // Keeps the focus, and a phone's keyboard, in the field for the next name.
            onMouseDown={(event) => event.preventDefault()}
            onBlur={leaving}
            onClick={() => {
              addTyped();
              input.current?.focus();
            }}
          />
        )}
      </HStack>
      {names.length > 0 && (
        <HStack as="ul" aria-label="Tillagda namn" gap={2} wrap="wrap">
          {names.map((added) => (
            <li key={added}>
              <Token
                label={added}
                onRemove={() => {
                  remove(added);
                  input.current?.focus();
                }}
              />
            </li>
          ))}
        </HStack>
      )}
      {offered.length > 0 && (
        <datalist id={listId}>
          {offered.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      )}
      <VisuallyHidden as="p" role="status">
        {announcement}
      </VisuallyHidden>
    </VStack>
  );
}
