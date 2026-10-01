"use client";

import dynamic from "next/dynamic";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Selector } from "@astryxdesign/core/Selector";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ParticipantsInput } from "@/components/flow/ParticipantsInput";
import type { FormField } from "@/lib/api";
import { MAX_SPEAKER_COUNT, readSpeakerCount, type DetailValue, type FlowSession } from "@/lib/flow-session";

// The calendar is loaded for a flow that asks for a date, not for every page.
const DateInput = dynamic(() => import("@astryxdesign/core/DateInput").then((module) => module.DateInput));

// The selector takes no empty value, and a choice must never be mistaken for "no choice": its items carry keys of
// their own, "none" for no choice and "opt:<n>" for the flow's n-th option, which no option string can be.
const NONE = "none";
const optionKey = (index: number) => `opt:${index}`;

// What a number field needs of the browser that the design system's types leave out (the input spreads what it does
// not know onto the element, so it works). A number detail is the browser's own number field with a number keyboard;
// the speaker count is text with one, because a number field reads "e", "-" or "2,5" as empty and says nothing, while
// this keeps what was typed for readSpeakerCount to call it no count.
const NUMBER = { type: "number", inputMode: "numeric" } as Record<string, string>;
const COUNT = { inputMode: "numeric", pattern: "[0-9]*" } as Record<string, string>;

/** The control a detail carries, by the name Eneo gave it, so a problem can move focus to it. */
function detailControl(name: string): HTMLElement | null {
  const marked = [...document.querySelectorAll<HTMLElement>("[data-detail-field]")].find((el) => el.dataset.detailField === name);
  const control = "input, textarea, [role=combobox]";
  return marked?.matches(control) ? marked : (marked?.querySelector<HTMLElement>(control) ?? null);
}

/** Moves focus to a detail's control (a field the page owns by name, like "Antal talare"). */
export function focusDetail(name: string): void {
  detailControl(name)?.focus();
}

/** "Skapa dokument"; when a required detail is missing, focus goes to it. */
export async function createDocument(session: FlowSession): Promise<void> {
  if (await session.createDocument()) return;
  const [first] = session.getSnapshot().invalid;
  // After the next paint, so details folded into one line have opened.
  if (first) requestAnimationFrame(() => focusDetail(first));
}

function options(field: FormField): string[] {
  return Array.isArray(field.options)
    ? // An empty option is the same as no choice, which "Välj"/"Inget val" already offers.
      field.options.filter((option): option is string => typeof option === "string" && option !== "")
    : [];
}

/** The details the flow asks for; a `list` field is a name input. */
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
  /** A line under a field for now, by its name: where its value came from. */
  notes?: Record<string, string>;
  /** The flow's own field that asks for the speaker count: a whole number, like Antal talare. */
  countField?: string | null;
  /** The flow ends in text, not a file. */
  makesText?: boolean;
}) {
  if (fields.length === 0) return null;
  return (
    // A required field is the form's default, so only an optional one is marked, and every other says it is required.
    <FormLayout defaultOptionality="required">
      {[...fields]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((field) => {
          const note = notes?.[field.name];
          const isInvalid = invalid.includes(field.name);
          const value = details[field.name];
          const text = typeof value === "string" ? value : "";
          const isCount = field.name === countField;
          const label = field.label || field.name;
          const required = !!field.required;
          const help = [
            field.description,
            field.type === "list" ? "Skriv ett namn och välj Lägg till. Skilj flera namn med komma." : null,
            note,
          ]
            .filter(Boolean)
            .join(" ");
          // Said at the field once the send finds it missing.
          const status = isInvalid
            ? {
                type: "error" as const,
                message:
                  isCount && text.trim()
                    ? `Skriv ett heltal från 1${required ? "" : ", eller lämna fältet tomt"}.`
                    : `Fyll i det här för att skapa ${makesText ? "texten" : "dokumentet"}.`,
              }
            : undefined;
          // The marks and the field's words, the same for each kind of field.
          const shared = {
            label,
            description: help || undefined,
            isOptional: !required,
            isRequired: required,
            statusVariant: "detached" as const,
            "data-detail-field": field.name,
          };
          if (field.type === "list") {
            return (
              <ParticipantsInput
                key={field.name}
                name={field.name}
                label={label}
                description={help || undefined}
                isOptional={!required}
                isRequired={required}
                names={Array.isArray(value) ? value : []}
                onChange={(names) => onChange(field.name, names)}
                suggestions={suggestions}
                onAdded={onNamesAdded}
                status={status}
              />
            );
          }
          if (field.type === "select" && options(field).length > 0) {
            const choices = options(field);
            return (
              <Selector
                key={field.name}
                {...shared}
                status={status}
                htmlName={field.name}
                presentation="adaptive"
                // Below the field, not over it: the default puts the open list on the field, hiding the control with focus.
                placement="below"
                options={[
                  // An optional choice can be taken back; a required one starts unchosen.
                  { value: NONE, label: required ? "Välj" : "Inget val" },
                  ...choices.map((option, index) => ({ value: optionKey(index), label: option })),
                ]}
                value={text && choices.includes(text) ? optionKey(choices.indexOf(text)) : NONE}
                onChange={(key) => onChange(field.name, key === NONE ? "" : choices[Number(key.slice(4))])}
              />
            );
          }
          if (field.type === "textarea" || field.type === "long_text") {
            return (
              <TextArea
                key={field.name}
                {...shared}
                status={status}
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
              <DateInput
                key={field.name}
                {...shared}
                status={status}
                value={(text || undefined) as never}
                onChange={(next) => onChange(field.name, next ?? "")}
              />
            );
          }
          return (
            <TextInput
              key={field.name}
              {...shared}
              {...(isCount ? COUNT : field.type === "number" ? NUMBER : undefined)}
              status={status}
              htmlName={field.name}
              autoComplete="off"
              // The field's width is its label's and help's too, so it is no narrower than they need.
              width={isCount ? "min(100%, 16rem)" : undefined}
              value={text}
              onChange={(next) => onChange(field.name, next)}
            />
          );
        })}
    </FormLayout>
  );
}

/** The name "Antal talare" carries, so a refused start can move focus to it. */
export const SPEAKER_COUNT_ID = "antal-talare";

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
      data-detail-field={SPEAKER_COUNT_ID}
      autoComplete="off"
      {...COUNT}
      value={value}
      onChange={onChange}
      // One paragraph, the one the field is described by: its second sentence says where a filled-in number came from,
      // since "Lämna tomt" beside it would contradict it.
      description={`Används som övre gräns. ${fromNames ? COUNT_FROM_NAMES : "Lämna tomt om du är osäker."}`}
      status={invalid ? { type: "error", message: `Skriv ett heltal från 1 till ${MAX_SPEAKER_COUNT}, eller lämna fältet tomt.` } : undefined}
      statusVariant="detached"
      // The field's width is its label's and help's too, so it is no narrower than they need.
      width="min(100%, 16rem)"
    />
  );
}
