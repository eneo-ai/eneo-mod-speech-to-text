"use client";

import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ParticipantsInput } from "@/components/flow/ParticipantsInput";
import type { FormField } from "@/lib/api";
import type { DetailValue, FlowSession } from "@/lib/flow-session";

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
    ? field.options.filter((option): option is string => typeof option === "string")
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
}: {
  fields: FormField[];
  details: Record<string, DetailValue>;
  /** Fields that must be filled before the document can be made. */
  invalid: readonly string[];
  onChange: (name: string, value: DetailValue) => void;
  suggestions: string[];
  onNamesAdded: (names: string[]) => void;
}) {
  if (fields.length === 0) return null;
  return (
    <FieldGroup className="gap-6">
      {[...fields]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((field) => {
          const id = detailFieldId(field.name);
          const helpId = `${id}-hjalp`;
          const errorId = `${id}-fel`;
          const isInvalid = invalid.includes(field.name);
          const value = details[field.name];
          const text = typeof value === "string" ? value : "";
          const help =
            field.type === "list"
              ? [field.description, "Skriv ett namn och tryck Enter."].filter(Boolean).join(" ")
              : field.description;
          const describedBy = [help ? helpId : null, isInvalid ? errorId : null].filter(Boolean).join(" ") || undefined;
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
                />
              ) : field.type === "select" && options(field).length > 0 ? (
                <select
                  id={id}
                  value={text}
                  onChange={(event) => onChange(field.name, event.target.value)}
                  aria-describedby={describedBy}
                  aria-invalid={isInvalid || undefined}
                  className="h-11 w-full rounded-xl border border-rule bg-paper px-3 text-[16px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <option value="">Välj</option>
                  {options(field).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : field.type === "textarea" || field.type === "long_text" ? (
                <Textarea
                  id={id}
                  value={text}
                  rows={4}
                  onChange={(event) => onChange(field.name, event.target.value)}
                  aria-describedby={describedBy}
                  aria-invalid={isInvalid || undefined}
                  className="rounded-xl text-[16px]"
                />
              ) : (
                <Input
                  id={id}
                  type={field.type === "date" ? "date" : field.type === "number" ? "number" : "text"}
                  value={text}
                  onChange={(event) => onChange(field.name, event.target.value)}
                  aria-describedby={describedBy}
                  aria-invalid={isInvalid || undefined}
                  className="h-11 rounded-xl text-[16px]"
                />
              )}
              {help && (
                <FieldDescription id={helpId} className="text-[13px]">
                  {help}
                </FieldDescription>
              )}
              {isInvalid && <FieldError id={errorId}>Fyll i det här för att skapa dokumentet.</FieldError>}
            </Field>
          );
        })}
    </FieldGroup>
  );
}
