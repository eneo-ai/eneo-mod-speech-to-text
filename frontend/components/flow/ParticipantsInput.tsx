import { useId, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { InputGroup } from "@astryxdesign/core/InputGroup";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import styles from "@/components/flow/ParticipantsInput.module.css";
import { addNames, hasSeparator, splitNames, takeNames } from "@/lib/participants";

const ADD_NAME = "Lägg till namn";

// The names an addition announces: "Anna Berg och Erik Lund". Each change names what changed, so two in a row never
// say the same words, which a live region would not announce again.
const NAMES = new Intl.ListFormat("sv", { type: "conjunction" });

// Astryx's types leave out the attributes a phone's keyboard and the browser's suggestions read, but its field passes
// them on to the input.
const NAME_HINTS = { autoCapitalize: "words", enterKeyHint: "enter" } as Record<string, string>;

/**
 * A `list` field as chips. "Lägg till" stands beside the input, off until a
 * name is typed, so a tap adds it on any device and the input keeps its width;
 * Enter (a phone's return key) or a comma adds it too, a pasted list is split
 * on commas, semicolons and line breaks,
 * Backspace in the empty input removes the last chip, and each chip has its
 * own remove button. Earlier names are offered as the browser's own
 * suggestions. Text left in the input becomes a chip when the field loses
 * focus, so a typed name is never lost.
 */
export function ParticipantsInput({
  label,
  names,
  onChange,
  suggestions,
  onAdded,
  description,
  error,
  isOptional,
  isRequired,
  fieldName,
}: {
  label: string;
  names: string[];
  onChange: (names: string[]) => void;
  suggestions: string[];
  /** Names the user just added, to offer them again next time. */
  onAdded?: (names: string[]) => void;
  /** Under the label, before the field. */
  description?: string;
  /** Said at the field when what it holds blocks sending. */
  error?: string;
  isOptional?: boolean;
  isRequired?: boolean;
  /** The detail's name, so a problem can move focus to the field (DetailsForm). */
  fieldName?: string;
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
    setAnnouncement(`${NAMES.format(fresh)} har lagts till.`);
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
    <VStack gap={2}>
      {/* Leaving the field and its "Lägg till" together adds what was typed; moving between them does not. */}
      <VStack
        onBlur={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null) || !text.trim()) return;
          addTyped();
        }}
      >
        <InputGroup
          label={label}
          description={description}
          isOptional={isOptional}
          isRequired={isRequired}
          status={error ? { type: "error", message: error } : undefined}
        >
          <TextInput
            ref={input}
            // The group is named by the field's label; read with it, this says what the input is for.
            label={ADD_NAME}
            isLabelHidden
            value={text}
            htmlName={fieldName}
            autoComplete="off"
            placeholder={ADD_NAME}
            isRequired={isRequired}
            isOptional={isOptional}
            // The group says what is wrong; the input says that it is.
            status={error ? { type: "error" } : undefined}
            data-detail-field={fieldName}
            {...NAME_HINTS}
            {...(offered.length > 0 ? { list: listId } : {})}
            onChange={(value, event) => {
              const picked =
                (event?.nativeEvent as InputEvent | undefined)?.inputType === "insertReplacementText" &&
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
              if (!hasSeparator(pasted)) return;
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
          <Button
            label="Lägg till"
            variant="secondary"
            isDisabled={!text.trim()}
            // Keeps the focus, and a phone's keyboard, in the field for the next name.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              addTyped();
              input.current?.focus();
            }}
          />
        </InputGroup>
      </VStack>
      {names.length > 0 && (
        <HStack as="ul" aria-label="Tillagda namn" role="list" wrap="wrap" gap={2} className={styles.names}>
          {names.map((name) => (
            <li key={name}>
              <Token
                label={name}
                onRemove={() => {
                  remove(name);
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
