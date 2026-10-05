import type { ReactNode } from "react";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { AccountMenu } from "@/components/AccountMenu";
import { BackToFlows } from "@/components/flow/BackToFlows";
import { HeaderBrand } from "@/components/HeaderBrand";
import { ModuleShell } from "@/kit/ModuleShell";
import styles from "./FlowFrame.module.css";
import { PRODUCT_NAME } from "@/lib/product";

/**
 * The frame of every view of a flow's page: the top bar, the skip link, the one main region and the page's width.
 *
 * The bar is the same in every state: the way back ("Alla flöden") at every width, after the brand from a laptop's
 * width, and the account (signing out asks first while leaving would lose something). `aside` (the flow, beside the
 * working card from a laptop's width) says the flow's name; a view without one names the flow in the bar on a phone
 * or tablet. Locked, it offers no way off the page at all.
 */
export function FlowFrame({
  title,
  titleIsHeading = true,
  locked = false,
  fill = false,
  aside,
  children,
}: {
  /** The flow's name in the bar below a laptop's width, for a view with no aside. */
  title?: string;
  /** False where the view's own heading names its state, as a run's views do. */
  titleIsHeading?: boolean;
  /** While leaving would abort what the view is doing (an upload under way): the view's own way out is the only one. */
  locked?: boolean;
  /** The window's height, with panes that scroll on their own (a recording); otherwise the page grows. */
  fill?: boolean;
  /** The flow, in a column beside `children` from a laptop's width and above them before it. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const heading = (
    <>
      {/* No link: the way back beside it is the one to the flows. */}
      <span className={[styles.bare, styles.fromLaptop].join(" ")}>
        <HeaderBrand linked={false} />
      </span>
      {!locked && <BackToFlows variant="ghost" />}
    </>
  );
  return (
    <ModuleShell
      label={PRODUCT_NAME}
      heading={heading}
      start={
        title &&
        (titleIsHeading ? (
          <Heading level={1} className={styles.belowLaptop}>
            {title}
          </Heading>
        ) : (
          <Text as="p" weight="semibold" type="large" className={[styles.belowLaptop, styles.besideTheWayBack].join(" ")}>
            {title}
          </Text>
        ))
      }
      end={!locked && <AccountMenu />}
      height={fill ? "fill" : "auto"}
    >
      <div className={[styles.page, aside && styles.columns, fill && styles.fill].filter(Boolean).join(" ")}>
        {aside}
        {children}
      </div>
    </ModuleShell>
  );
}
