import { AudioLines, Mic, Upload, type LucideIcon } from "lucide-react";
import { forwardRef } from "react";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { VStack } from "@astryxdesign/core/Stack";
import type { InputMode } from "@/lib/flow-session";

export const MODE_TEXT: Record<InputMode, { name: string; line: string; icon: LucideIcon }> = {
  stromma: { name: "Strömma", line: "Se texten medan du pratar.", icon: AudioLines },
  "spela-in": { name: "Spela in", line: "Spela in nu och transkribera efteråt.", icon: Mic },
  "ladda-upp": { name: "Ladda upp", line: "Välj en ljudfil från din enhet.", icon: Upload },
};

/**
 * "Hur vill du lägga till ljudet?": the offered modes as one group of radios, each with its line. Selecting only
 * selects; the arrow keys move between them. The heading takes the focus when the setup appears, the group is
 * named by the same words.
 */
export const ModeCards = forwardRef<
  HTMLHeadingElement,
  { modes: InputMode[]; mode: InputMode | null; onSelect: (mode: InputMode) => void }
>(function ModeCards({ modes, mode, onSelect }, heading) {
  return (
    <VStack gap={4}>
      <Heading level={2} ref={heading} data-phase-heading tabIndex={-1}>
        Hur vill du lägga till ljudet?
      </Heading>
      <RadioList label="Hur vill du lägga till ljudet?" isLabelHidden value={mode ?? ""} onChange={(value) => onSelect(value as InputMode)}>
        {modes.map((value) => {
          const { name, line, icon } = MODE_TEXT[value];
          return <RadioListItem key={value} value={value} label={name} description={line} startContent={<Icon icon={icon} color="accent" />} />;
        })}
      </RadioList>
    </VStack>
  );
});
