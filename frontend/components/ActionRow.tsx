import { Children, type ReactNode } from "react";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Stack } from "@astryxdesign/core/Stack";

// Where the design system's alert dialog stacks its own actions, and other rows of actions follow it.
export const STACKED = "(max-width: 640px)";

/**
 * A step's decision (a review's Avvisa and its approval, a dialog's Avbryt and Spara), laid out as the design system's
 * alert dialog lays out its own: one row at the end of its space with the main action last, and up to 640 px wide a
 * stack across the whole width with the main action on top. The page's order follows the screen's at both widths, so
 * the keyboard meets the main action first where it stands first. `children` come in the row's order, the main last.
 * An editor's own buttons are no decision: they stand small at the start of the field they belong to. A way on after a
 * card's explanation (a failed run's Försök igen) stands at the start (`align`), where the words it follows start.
 */
export function ActionRow({ children, align = "end" }: { children: ReactNode; align?: "start" | "end" }) {
  const stacked = useMediaQuery(STACKED);
  const actions = Children.toArray(children);
  return (
    <Stack
      direction={stacked ? "vertical" : "horizontal"}
      gap={2}
      hAlign={stacked ? "stretch" : align}
      wrap={stacked ? "nowrap" : "wrap"}
    >
      {stacked ? actions.reverse() : actions}
    </Stack>
  );
}
