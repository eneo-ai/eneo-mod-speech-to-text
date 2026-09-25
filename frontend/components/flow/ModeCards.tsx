"use client";

import { AudioLines, Mic, Upload, type LucideIcon } from "lucide-react";
import { forwardRef, useId } from "react";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { InputMode } from "@/lib/flow-session";

export const MODE_TEXT: Record<InputMode, { name: string; line: string; icon: LucideIcon }> = {
  stromma: { name: "Strömma", line: "Se texten medan du pratar.", icon: AudioLines },
  "spela-in": { name: "Spela in", line: "Spela in nu och transkribera efteråt.", icon: Mic },
  "ladda-upp": { name: "Ladda upp", line: "Välj en ljudfil från din enhet.", icon: Upload },
};

/**
 * "Hur vill du ge ljudet?": the offered modes as one radio group of equal
 * cards. Selecting only selects; the arrow keys move between the cards.
 */
export const ModeCards = forwardRef<
  HTMLHeadingElement,
  { modes: InputMode[]; mode: InputMode | null; onSelect: (mode: InputMode) => void }
>(function ModeCards({ modes, mode, onSelect }, heading) {
  const headingId = useId();
  return (
    <FieldSet className="gap-0">
      {/* A legend does not take part in the fieldset's gap, so it keeps its own margin. */}
      <FieldLegend className="mb-4">
        <h2 ref={heading} id={headingId} data-phase-heading tabIndex={-1} className="text-[20px] font-semibold tracking-[-0.01em] text-ink outline-none">
          Hur vill du ge ljudet?
        </h2>
      </FieldLegend>
      <RadioGroup
        aria-labelledby={headingId}
        value={mode ?? ""}
        onValueChange={(value) => onSelect(value as InputMode)}
        className="gap-3"
      >
        {modes.map((value) => {
          const { name, line, icon: Icon } = MODE_TEXT[value];
          const id = `satt-${value}`;
          return (
            <FieldLabel key={value} htmlFor={id} className="transition-colors duration-150">
              <Field orientation="horizontal" className="min-h-11 gap-4 has-[>[data-slot=field-content]]:items-center">
                <Icon aria-hidden className="size-6 shrink-0 text-primary" strokeWidth={1.75} />
                <FieldContent className="gap-0.5">
                  <FieldTitle id={`${id}-namn`} className="text-[17px] font-semibold text-ink">{name}</FieldTitle>
                  <FieldDescription id={`${id}-rad`} className="text-[15px]">{line}</FieldDescription>
                </FieldContent>
                {/* The card shows keyboard focus; the circle does not need a ring of its own. Named by the
                    title and described by the line, not by the whole card the label wraps. */}
                <RadioGroupItem
                  value={value}
                  id={id}
                  aria-labelledby={`${id}-namn`}
                  aria-describedby={`${id}-rad`}
                  className="focus-visible:ring-0 focus-visible:ring-offset-0"
                />
              </Field>
            </FieldLabel>
          );
        })}
      </RadioGroup>
    </FieldSet>
  );
});
