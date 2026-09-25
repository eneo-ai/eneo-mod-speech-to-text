"use client";

import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ParticipantsInput } from "@/components/flow/ParticipantsInput";
import type { FormField } from "@/lib/api";
import { MAX_SPEAKER_COUNT, readSpeakerCount, type DetailValue, type FlowSession } from "@/lib/flow-session";

// Radix Select takes no empty value, so its items carry keys of their own:
// "none" for no choice and "opt:<n>" for the flow's n-th option, which no
// option string can be mistaken for.
const NONE = "none";
const optionKey = (index: number) => `opt:${index}`;

/** The id a field's control carries, so a problem can move focus to it. */
export const detailFieldId = (name: string) => `detalj-${name}`;

/** "Skapa dokument"; when a required detail is missing, focus goes to it. */
export async function createDocument(session: FlowSession): Promise<void> {
  if (await session.createDocument()) return;
  const [first] = session.getSnapshot().invalid;
  // After the next paint, so details folded into one line have opened.
  if (first) requestAnimationFrame(() => document.getElementById(detailFieldId(first))?.focus());
}

function options(field: FormField): string[] {
  return Array.isArray(field.options)
    ? // An empty option is the same as no choice, which "Välj"/"Inget val" already offers.
      field.options.filter((option): option is string => typeof option === "string" && option !== "")
    : [];
}

/** The details the flow asks for; a `list` field is a chip input. */
export function DetailsForm({
  fields,
  details,
  invalid,
  onChange,
  suggestions,
  onNamesAdded,
  notes,
  makesText = false,
}: {
  fields: FormField[];
  details: Record<string, DetailValue>;
  /** Fields that must be filled before the document can be made. */
  invalid: readonly string[];
  onChange: (name: string, value: DetailValue) => void;
  suggestions: string[];
  onNamesAdded: (names: string[]) => void;
  /** A line under a field for now, by its name: where its value came from. */
  notes?: Record<string, string>;
  /** The flow ends in text, not a file. */
  makesText?: boolean;
}) {
  if (fields.length === 0) return null;
  return (
    <FieldGroup className="gap-6">
      {[...fields]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((field) => {
          const id = detailFieldId(field.name);
          const helpId = `${id}-hjalp`;
          const noteId = `${id}-not`;
          const errorId = `${id}-fel`;
          const note = notes?.[field.name];
          const isInvalid = invalid.includes(field.name);
          const value = details[field.name];
          const text = typeof value === "string" ? value : "";
          const help =
            field.type === "list"
              ? [field.description, "Skriv ett namn och välj Lägg till. Skilj flera namn med komma."].filter(Boolean).join(" ")
              : field.description;
          const describedBy =
            [help ? helpId : null, note ? noteId : null, isInvalid ? errorId : null].filter(Boolean).join(" ") || undefined;
          // Said before sending too, not only once the send finds it missing.
          const required = field.required || undefined;
          return (
            <Field key={field.name} data-invalid={isInvalid || undefined} className="gap-2">
              <FieldLabel htmlFor={id} className="gap-1 text-[15px] font-semibold text-ink">
                {field.label || field.name}{" "}
                {!field.required && <span className="font-normal text-ink-soft">(valfritt)</span>}
              </FieldLabel>
              {field.type === "list" ? (
                <ParticipantsInput
                  id={id}
                  names={Array.isArray(value) ? value : []}
                  onChange={(names) => onChange(field.name, names)}
                  suggestions={suggestions}
                  onAdded={onNamesAdded}
                  describedBy={describedBy}
                  invalid={isInvalid}
                  required={required}
                />
              ) : field.type === "select" && options(field).length > 0 ? (
                <Select
                  name={field.name}
                  value={text && options(field).includes(text) ? optionKey(options(field).indexOf(text)) : NONE}
                  onValueChange={(key) => onChange(field.name, key === NONE ? "" : options(field)[Number(key.slice(4))])}
                >
                  <SelectTrigger
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={isInvalid || undefined}
                    aria-required={required}
                    className="text-[16px]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* An optional choice can be taken back; a required one starts unchosen. */}
                    <SelectItem value={NONE}>{field.required ? "Välj" : "Inget val"}</SelectItem>
                    {options(field).map((option, index) => (
                      <SelectItem key={index} value={optionKey(index)}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : field.type === "textarea" || field.type === "long_text" ? (
                <Textarea
                  id={id}
                  name={field.name}
                  autoComplete="off"
                  value={text}
                  rows={4}
                  onChange={(event) => onChange(field.name, event.target.value)}
                  aria-describedby={describedBy}
                  aria-invalid={isInvalid || undefined}
                  aria-required={required}
                  className="rounded-xl text-[16px]"
                />
              ) : (
                <Input
                  id={id}
                  name={field.name}
                  autoComplete="off"
                  type={field.type === "date" ? "date" : field.type === "number" ? "number" : "text"}
                  // A phone's number keyboard, not the one with letters and punctuation.
                  inputMode={field.type === "number" ? "numeric" : undefined}
                  value={text}
                  onChange={(event) => onChange(field.name, event.target.value)}
                  aria-describedby={describedBy}
                  aria-invalid={isInvalid || undefined}
                  aria-required={required}
                  className="rounded-xl text-[16px]"
                />
              )}
              {help && (
                <FieldDescription id={helpId} className="text-[13px]">
                  {help}
                </FieldDescription>
              )}
              {note && (
                <FieldDescription id={noteId} className="text-[13px]">
                  {note}
                </FieldDescription>
              )}
              {isInvalid && <FieldError id={errorId}>Fyll i det här för att skapa {makesText ? "texten" : "dokumentet"}.</FieldError>}
            </Field>
          );
        })}
    </FieldGroup>
  );
}

/** The id "Antal talare" carries, so a refused start can move focus to it. */
export const SPEAKER_COUNT_ID = "antal-talare";

/** Under a speaker count the names filled in, until the person edits it. */
export const COUNT_FROM_NAMES = "Från antalet deltagare. Ändra om fler talar.";

/** "Antal talare": an upper bound on the speakers the run tells apart; left empty, Eneo decides. */
export function SpeakerCountField({
  value,
  onChange,
  fromNames = false,
}: {
  value: string;
  onChange: (value: string) => void;
  /** The value is the number of names, not yet edited. */
  fromNames?: boolean;
}) {
  const helpId = `${SPEAKER_COUNT_ID}-hjalp`;
  const namesId = `${SPEAKER_COUNT_ID}-namn`;
  const errorId = `${SPEAKER_COUNT_ID}-fel`;
  const invalid = readSpeakerCount(value) === "invalid";
  return (
    <Field data-invalid={invalid || undefined} className="gap-2">
      <FieldLabel htmlFor={SPEAKER_COUNT_ID} className="gap-1 text-[15px] font-semibold text-ink">
        Antal talare <span className="font-normal text-ink-soft">(om du vet)</span>
      </FieldLabel>
      <Input
        id={SPEAKER_COUNT_ID}
        name={SPEAKER_COUNT_ID}
        autoComplete="off"
        type="number"
        // A phone's number keyboard, not the one with letters and punctuation.
        inputMode="numeric"
        min={1}
        max={MAX_SPEAKER_COUNT}
        step={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={[helpId, fromNames ? namesId : null, invalid ? errorId : null].filter(Boolean).join(" ")}
        aria-invalid={invalid || undefined}
        // Room for two digits: the field makes each child full width, so this caps it.
        className="max-w-28 rounded-xl text-[16px]"
      />
      <FieldDescription id={helpId} className="text-[13px]">
        Används som övre gräns. Lämna tomt om du är osäker.
      </FieldDescription>
      {fromNames && (
        <FieldDescription id={namesId} className="text-[13px]">
          {COUNT_FROM_NAMES}
        </FieldDescription>
      )}
      {invalid && (
        <FieldError id={errorId}>Skriv ett heltal från 1 till {MAX_SPEAKER_COUNT}, eller lämna fältet tomt.</FieldError>
      )}
    </Field>
  );
}
