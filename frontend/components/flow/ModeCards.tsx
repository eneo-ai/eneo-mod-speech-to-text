"use client";

import { AudioLines, Mic, Upload, type LucideIcon } from "lucide-react";
import { Icon } from "@astryxdesign/core/Icon";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { VStack } from "@astryxdesign/core/VStack";
import { StateHeading } from "@/components/flow/StateCard";
import type { InputMode } from "@/lib/flow-session";

export const MODE_TEXT: Record<InputMode, { name: string; line: string; icon: LucideIcon }> = {
  stromma: { name: "Strömma", line: "Se texten medan du pratar.", icon: AudioLines },
  "spela-in": { name: "Spela in", line: "Spela in nu och transkribera efteråt.", icon: Mic },
  "ladda-upp": { name: "Ladda upp", line: "Välj en ljudfil från din enhet.", icon: Upload },
};

const QUESTION = "Hur vill du lägga till ljudet?";

/**
 * "Hur vill du lägga till ljudet?": the offered modes as one radio group. Selecting only selects; the arrow keys move
 * between the modes. The question is the heading that takes focus when the setup appears, and names the group.
 */
export function ModeCards({
  modes,
  mode,
  onSelect,
}: {
  modes: InputMode[];
  mode: InputMode | null;
  onSelect: (mode: InputMode) => void;
}) {
  return (
    <VStack gap={4}>
      <StateHeading level={2} data-phase-heading tabIndex={-1}>
        {QUESTION}
      </StateHeading>
      <RadioList label={QUESTION} isLabelHidden value={mode ?? ""} onChange={(value) => onSelect(value as InputMode)}>
        {modes.map((value) => {
          const { name, line, icon } = MODE_TEXT[value];
          return (
            <RadioListItem
              key={value}
              value={value}
              label={name}
              description={line}
              startContent={<Icon icon={icon} color="accent" />}
            />
          );
        })}
      </RadioList>
    </VStack>
  );
}
