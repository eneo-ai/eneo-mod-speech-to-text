import type { LucideIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { VStack } from "@astryxdesign/core/VStack";
import { IconTile } from "@/components/IconTile";

/**
 * The card a flow's page shows a state in, beside the flow (ready, sending, running, failed): one state
 * replaces another in the same place. 16 px in on a phone, 24 px on a tablet and 32 px beside the flow.
 */
export function StateCard({ children, ...props }: ComponentProps<typeof Card>) {
  const tablet = useMediaQuery("(min-width: 768px)", true);
  const laptop = useMediaQuery("(min-width: 1024px)", true);
  return (
    <Card padding={laptop ? 8 : tablet ? 6 : 4} {...props}>
      <VStack gap={6}>{children}</VStack>
    </Card>
  );
}

/**
 * A state's head in its card (a recording made, a document on its way, a run under way): its tile and its heading, one
 * anatomy from one state to the next. The tile stands where the line has room for it beside the heading (from a 375 px
 * phone, "Dokumentet skapas" beside it); on narrower ones the heading starts the card alone, as a failure's does.
 */
export function StateHead({ icon, children }: { icon: LucideIcon; children: ReactNode }) {
  const roomy = useMediaQuery("(min-width: 375px)", true);
  return (
    <HStack gap={4} vAlign="center">
      {roomy && <IconTile icon={icon} />}
      {children}
    </HStack>
  );
}
