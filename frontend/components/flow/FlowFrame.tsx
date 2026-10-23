import type { ReactNode } from "react";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { HStack } from "@astryxdesign/core/HStack";
import { AccountMenu } from "@/components/AccountMenu";
import { BackToFlows } from "@/components/flow/BackToFlows";
import { HeaderBrand } from "@/components/HeaderBrand";
import { ModuleShell } from "@/kit/ModuleShell";
import styles from "./FlowFrame.module.css";
import { useNarrowerThan } from "./useRoomInRow";
import { PRODUCT_NAME } from "@/lib/product";

/**
 * The frame of every view of a flow's page: the top bar, the skip link, the one main region and the page's width.
 *
 * The bar is the same in every state, one line at every width: the way back ("Alla flöden"), after the brand (a link to
 * the flows too) from a tablet's width, and the account (signing out asks first while leaving would lose something).
 * `aside` (the flow, beside the working card from a laptop's width) says the flow's name; a view without one says it
 * in its own first lines (the review, the result). Locked, it offers no way off the page at all, and the brand alone
 * fills the bar at every width, so the bar keeps its height and the organisation its place while the page waits.
 */
export function FlowFrame({
  locked = false,
  fill = false,
  aside,
  children,
}: {
  /** While leaving would abort what the view is doing (an upload under way): the view's own way out is the only one. */
  locked?: boolean;
  /** The window's height, with panes that scroll on their own (a recording); otherwise the page grows. */
  fill?: boolean;
  /** The flow, in a column beside `children` from a laptop's width and above them before it. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const tablet = useMediaQuery("(min-width: 768px)");
  // The bar's one line holds the way back's arrow and words, the account and, from a tablet's width, the brand: 12 and
  // 20 rem of the root's text. Where the reader's large text leaves less, the way back is its arrow alone.
  const room = useNarrowerThan(tablet ? 20 : 12);
  const heading = (
    // 8 px apart, as the controls a finger presses are.
    <HStack gap={2} vAlign="center">
      {/* A link to the flows as on every page, beside the way back: a lockup is where people look for home. Leaving
          asks first while it would lose something, as the way back does; locked, neither leads off the page. On a
          phone the bar keeps its room for the way back and the account. */}
      {(tablet || locked) && <HeaderBrand linked={!locked} />}
      {!locked && <BackToFlows variant="ghost" iconOnly={room.narrow} />}
    </HStack>
  );
  return (
    <ModuleShell
      label={PRODUCT_NAME}
      heading={heading}
      end={!locked && <AccountMenu />}
      height={fill ? "fill" : "auto"}
    >
      <div ref={room.ref} className={[styles.page, aside && styles.columns, fill && styles.fill].filter(Boolean).join(" ")}>
        {aside}
        {children}
      </div>
    </ModuleShell>
  );
}
