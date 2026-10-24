import { User } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
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
// them on to the input. A name is no word of the dictionary: the spelling check would underline most of them, and iOS's
// autocorrect, which spellcheck="false" leaves on, would change them ("Maja" to "Mana").
const NAME_HINTS = { autoCapitalize: "words", autoCorrect: "off", enterKeyHint: "enter", spellCheck: "false" } as Record<string, string>;

// Each name added starts with a capital, as the first one typed does: iOS leaves its shift key off in the field the page
// has emptied. Only the first letter; iOS capitalises each later word itself.
// ponytail: "af Klint" becomes "Af Klint"; a speaker's name field takes it as typed.
const capitalised = (names: string[]) => names.map((name) => name.charAt(0).toLocaleUpperCase("sv") + name.slice(1));

/**
 * A `list` field as chips. "Lägg till" stands beside the input, one piece with
 * it, off until a name is typed, so a tap adds it on any device and the input
 * keeps its width;
 * Enter (a phone's return key) or a comma adds it too, a pasted list is split
 * on commas, semicolons and line breaks,
 * Backspace in the empty input removes the last chip, and each chip has its
 * own remove button, which hands the focus back to the input, except after a
 * finger's press: there that would open the phone's keyboard for nothing.
 * Earlier names are offered as the browser's own suggestions, and an empty
 * field offers the names it was last sent with in one press. Text left in
 * the input becomes a chip when the field loses focus, so a typed name is
 * never lost.
 */
export function ParticipantsInput({
  label,
  names,
  onChange,
  suggestions,
  previous = [],
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
  /** The names the field was last sent with on this flow (lib/participants lastNames). */
  previous?: readonly string[];
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
  // How the last press in the chips was made. Read from the press itself: WebKit says a tap's click is a mouse's.
  const pressedWith = useRef("");
  const namesList = useRef<HTMLElement>(null);

  function add(added: string[]) {
    const next = addNames(names, capitalised(added));
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

  // A field that goes while a name is typed in it (the flow's details move when a tablet is turned or the window crosses a
  // laptop's width) keeps the name, as leaving the field does.
  const typed = useRef({ text, names, onChange, onAdded });
  typed.current = { text, names, onChange, onAdded };
  useEffect(
    () => () => {
      const { text: left, names: kept, onChange: change, onAdded: added } = typed.current;
      const next = addNames(kept, capitalised(splitNames(left)));
      if (next.length === kept.length) return;
      change(next);
      added?.(next.slice(kept.length));
    },
    [],
  );

  // A field offering earlier names, Safari on a phone on its side leaves under the keyboard's bar of suggestions, without
  // moving the visible part to it (a field offering nothing it shows). Once the keyboard is open, the page scrolls the
  // field a spacing (1rem at the browser's default size) above it, where what is left visible can hold it: with Safari's
  // own bars shown, the keyboard leaves nothing.
  const offers = offered.length > 0;
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport || !offers) return;
    let frame = 0;
    const reveal = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const field = input.current;
        if (!field || document.activeElement !== field || viewport.offsetTop > 0) return;
        const { top, bottom } = field.getBoundingClientRect();
        if (bottom > viewport.height && viewport.height >= bottom - top + 32) window.scrollBy(0, bottom - viewport.height + 16);
      });
    };
    viewport.addEventListener("resize", reveal);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", reveal);
    };
  }, [offers]);

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
      {/* Where the chips will be: last time's names in one press, which says what it added and leaves the focus in the
          field for the next name. */}
      {names.length === 0 && previous.length > 0 && (
        <HStack onPointerDown={(event) => (pressedWith.current = event.pointerType)} onKeyDown={() => (pressedWith.current = "")}>
          <Button
            label={`Lägg till förra gångens namn (${previous.length})`}
            variant="ghost"
            size="sm"
            className={styles.previous}
            onClick={() => {
              add([...previous]);
              // A finger would have the phone's keyboard open over half the screen: the focus goes to the first name's
              // remove instead, once the names are drawn, so it is not lost with the button.
              if (pressedWith.current !== "touch") input.current?.focus();
              else requestAnimationFrame(() => namesList.current?.querySelector<HTMLElement>("button")?.focus());
            }}
          />
        </HStack>
      )}
      {names.length > 0 && (
        <HStack
          as="ul"
          ref={namesList}
          aria-label="Tillagda namn"
          role="list"
          wrap="wrap"
          gap={2}
          className={styles.names}
          onPointerDown={(event) => (pressedWith.current = event.pointerType)}
          onKeyDown={() => (pressedWith.current = "")}
        >
          {names.map((name) => (
            <li key={name}>
              {/* A person, not yet a speaker: a chip in the deployment's tint with a person icon in its colour, rather than
                  a speaker's colour, which only the review maps. */}
              <Token
                label={name}
                color="blue"
                icon={<Icon icon={User} size="sm" color="accent" />}
                onRemove={() => {
                  // With a finger the focus goes to the next name's remove, or the one before it, and not into the field,
                  // which would open the phone's keyboard; the removed button has gone with its name.
                  const removes = [...(namesList.current?.querySelectorAll<HTMLElement>("button") ?? [])];
                  const at = names.indexOf(name);
                  remove(name);
                  if (pressedWith.current !== "touch") input.current?.focus();
                  else (removes[at + 1] ?? removes[at - 1])?.focus();
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
