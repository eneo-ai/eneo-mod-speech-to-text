import type { ComponentProps } from "react";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Selector } from "@astryxdesign/core/Selector";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ParticipantsInput } from "@/components/flow/ParticipantsInput";
import styles from "@/components/flow/DetailsForm.module.css";
import type { FormField } from "@/lib/api";
import { MAX_SPEAKER_COUNT, readSpeakerCount, type DetailValue, type FlowSession } from "@/lib/flow-session";
import { LoadFailure } from "@/components/LoadFailure";
import { lazyLoader, useLoaded } from "@/lib/lazy-component";

// A calendar is rarely asked for and costs a popover: it loads when a flow has a date.
const calendar = lazyLoader(() => import("@astryxdesign/core/DateInput").then((module) => module.DateInput));
type DateInputType = typeof import("@astryxdesign/core/DateInput").DateInput;
type IsoDate = NonNullable<ComponentProps<DateInputType>["value"]>;
// What the person typed is kept as it is; the calendar shows only a whole date.
const isoDate = (text: string) => (/^\d{4}-\d{2}-\d{2}$/.test(text) ? (text as IsoDate) : undefined);

// The selector's items carry keys of their own: "none" for no choice and "opt:<n>" for the flow's n-th option, which
// no option string can be mistaken for.
const NONE = "none";
const optionKey = (index: number) => `opt:${index}`;

// Astryx's types leave out the attributes of a phone's number keyboard, but its field passes them on to the input.
const NUMERIC = { inputMode: "numeric", pattern: "[0-9]*" } as Record<string, string>;

type DateFieldProps = Pick<ComponentProps<typeof TextInput>, "label" | "description" | "isOptional" | "isRequired" | "status" | "statusVariant"> & {
  "data-detail-field": string;
  /** The calendar's own styling (its button at the field's height for a finger); the plain field has none to match. */
  className: string;
  name: string;
  text: string;
  onChange: (next: string) => void;
};

/**
 * A date: the design system's calendar once its code has arrived. Until then, and if it never does (a tab older than
 * the deploy that replaced its files), a plain text field with the same label and value, which takes a date as well
 * (2026-09-24); if the code is gone a line says so and offers the person's reload, which gives back the details draft.
 * No boundary and no reload by itself: nothing can unmount the form and what has been typed in it.
 */
function DateField({ name, text, onChange, className, ...common }: DateFieldProps) {
  const { value: DateInput, failed } = useLoaded(calendar);
  if (DateInput) return <DateInput {...common} className={className} value={isoDate(text)} onChange={(next) => onChange(next ?? "")} />;
  return (
    <>
      <TextInput {...common} htmlName={name} autoComplete="off" value={text} onChange={onChange} />
      {failed && <LoadFailure keeps="Det du har skrivit finns kvar.">Kalendern kunde inte läsas in.</LoadFailure>}
    </>
  );
}

/**
 * The control of a detail by its name, so a problem can move focus to it. The design system's fields own their ids,
 * so a field is found by the name it carries (`data-detail-field`), on the control or inside what holds it.
 */
function detailControl(name: string): HTMLElement | null {
  const marked = document.querySelector<HTMLElement>(`[data-detail-field="${CSS.escape(name)}"]`);
  const control = "input, textarea, button, [role=combobox]";
  return marked?.matches(control) ? marked : (marked?.querySelector<HTMLElement>(control) ?? null);
}

/** "Skapa dokument"; when a required detail is missing, focus goes to it. */
export async function createDocument(session: FlowSession): Promise<void> {
  if (await session.createDocument()) return;
  const [first] = session.getSnapshot().invalid;
  // After the next paint, so details folded into one line have opened.
  if (first) requestAnimationFrame(() => detailControl(first)?.focus());
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
  countField = null,
  makesText = false,
}: {
  fields: FormField[];
  details: Record<string, DetailValue>;
  /** Details that block sending: a required one empty, or the flow's own speaker count holding no count. */
  invalid: readonly string[];
  onChange: (name: string, value: DetailValue) => void;
  suggestions: string[];
  onNamesAdded: (names: string[]) => void;
  /** A line under a field, by its name, until the person edits it: where its value came from. */
  notes?: Record<string, string>;
  /** The flow's own field that asks for the speaker count: a whole number, like Antal talare. */
  countField?: string | null;
  /** The flow ends in text, not a file. */
  makesText?: boolean;
}) {
  if (fields.length === 0) return null;
  // Required is the form's default: a field says only when it is optional ("Valfritt"), and every one of them still
  // says "required" to a screen reader before sending, not only once the send finds it missing.
  return (
    <FormLayout defaultOptionality="required">
      {[...fields]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((field) => {
          const note = notes?.[field.name];
          const isInvalid = invalid.includes(field.name);
          const value = details[field.name];
          const text = typeof value === "string" ? value : "";
          const label = field.label || field.name;
          const isCount = field.name === countField;
          const help =
            field.type === "list"
              ? [field.description, "Skriv ett namn och välj Lägg till. Skilj flera namn med komma."].filter(Boolean).join(" ")
              : field.description;
          const description = [help, note].filter(Boolean).join(" ") || undefined;
          const error = isInvalid
            ? isCount && text.trim()
              ? `Skriv ett heltal från 1${field.required ? "" : ", eller lämna fältet tomt"}.`
              : `Fyll i det här för att skapa ${makesText ? "texten" : "dokumentet"}.`
            : undefined;
          const common = {
            label,
            description,
            isOptional: !field.required,
            isRequired: !!field.required,
            status: error ? ({ type: "error", message: error } as const) : undefined,
            statusVariant: "detached",
            "data-detail-field": field.name,
          } as const;
          const opts = options(field);
          if (field.type === "list") {
            return (
              <ParticipantsInput
                key={field.name}
                label={label}
                names={Array.isArray(value) ? value : []}
                onChange={(names) => onChange(field.name, names)}
                suggestions={suggestions}
                onAdded={onNamesAdded}
                description={help || undefined}
                error={error}
                isOptional={!field.required}
                isRequired={!!field.required}
                fieldName={field.name}
              />
            );
          }
          if (field.type === "select" && opts.length > 0) {
            return (
              <Selector
                key={field.name}
                {...common}
                htmlName={field.name}
                // An optional choice can be taken back; a required one starts unchosen.
                options={[
                  { value: NONE, label: field.required ? "Välj" : "Inget val" },
                  ...opts.map((option, index) => ({ value: optionKey(index), label: option })),
                ]}
                value={text && opts.includes(text) ? optionKey(opts.indexOf(text)) : NONE}
                onChange={(key) => onChange(field.name, key === NONE ? "" : opts[Number(key.slice(4))])}
              />
            );
          }
          if (field.type === "textarea" || field.type === "long_text") {
            return (
              <TextArea
                key={field.name}
                {...common}
                htmlName={field.name}
                autoComplete="off"
                rows={4}
                value={text}
                onChange={(next) => onChange(field.name, next)}
              />
            );
          }
          if (field.type === "date") {
            return (
              <DateField
                key={field.name}
                {...common}
                className={styles.date}
                name={field.name}
                text={text}
                onChange={(next) => onChange(field.name, next)}
              />
            );
          }
          return (
            <TextInput
              key={field.name}
              {...common}
              htmlName={field.name}
              autoComplete="off"
              // The count is text with a number keyboard, as Antal talare: a number field reads "e", "-" or "2,5" as
              // empty and says nothing.
              {...(isCount || field.type === "number" ? NUMERIC : {})}
              value={text}
              onChange={(next) => onChange(field.name, next)}
              className={isCount ? styles.count : undefined}
            />
          );
        })}
    </FormLayout>
  );
}

/** What "Antal talare" is found by, so a refused start can move focus to it. */
const SPEAKER_COUNT_ID = "antal-talare";

/** Moves focus to "Antal talare". The design system's field owns its id, so it is found by its name. */
export const focusSpeakerCount = () => detailControl(SPEAKER_COUNT_ID)?.focus();

/** Said of a speaker count the names filled in, until the person edits it: this module's field and the flow's own. */
export const COUNT_FROM_NAMES = "Ifyllt från antalet deltagare, ändra om fler talar.";

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
  const invalid = readSpeakerCount(value) === "invalid";
  return (
    <TextInput
      label="Antal talare (om du vet)"
      htmlName={SPEAKER_COUNT_ID}
      autoComplete="off"
      // Text with a number keyboard: a number field reads "e", "-" or "+" as empty and says nothing, while this
      // keeps what was typed for readSpeakerCount to call it no count.
      {...NUMERIC}
      value={value}
      onChange={onChange}
      // One paragraph: its second sentence says where a filled-in number came from, since "Lämna tomt" beside it
      // would contradict it.
      description={`Används som övre gräns. ${fromNames ? COUNT_FROM_NAMES : "Lämna tomt om du är osäker."}`}
      status={invalid ? { type: "error", message: `Skriv ett heltal från 1 till ${MAX_SPEAKER_COUNT}, eller lämna fältet tomt.` } : undefined}
      statusVariant="detached"
      data-detail-field={SPEAKER_COUNT_ID}
      className={styles.count}
    />
  );
}
