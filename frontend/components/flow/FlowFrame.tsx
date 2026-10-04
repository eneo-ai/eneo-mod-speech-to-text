"use client";

import type { ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { AccountMenu } from "@/components/AccountMenu";
import { HeaderBrand } from "@/components/AppHeader";
import { ModuleShell } from "@/kit/ModuleShell";
import { RouterLink } from "@/kit/RouterLink";
import styles from "./FlowFrame.module.css";

/**
 * The frame of every view of a flow's page: the top bar, the skip link, the one main region and the page's width.
 *
 * The bar's way back is the arrow below a laptop's width and the brand from it; `aside` (the flow, beside the
 * working card from a laptop's width) says the flow's name there, so a view with an aside gives no `title`. A view
 * without one names the flow in the bar on a phone or tablet. Locked, it offers no way off the page at all.
 */
export function FlowFrame({
  title,
  titleIsHeading = true,
  trailing,
  locked = false,
  fill = false,
  aside,
  children,
}: {
  /** The flow's name in the bar below a laptop's width, for a view with no aside. */
  title?: string;
  /** False where the view's own heading names its state, as a run's views do. */
  titleIsHeading?: boolean;
  /** Replaces the account menu on every width, e.g. with the mode while recording, which signing out would drop. */
  trailing?: ReactNode;
  /** While leaving would abort what the view is doing (an upload under way): the view's own way out is the only one. */
  locked?: boolean;
  /** The window's height, with panes that scroll on their own (a recording); otherwise the page grows. */
  fill?: boolean;
  /** The flow, in a column beside `children` from a laptop's width and above them before it. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const account = !locked && trailing === undefined;
  const heading = (
    <>
      {!locked && (
        <Button
          as={RouterLink}
          href="/flows"
          label="Alla flöden"
          isIconOnly
          icon={<Icon icon="chevronLeft" />}
          variant="ghost"
          className={styles.belowLaptop}
        />
      )}
      <span className={[styles.bare, styles.fromLaptop].join(" ")}>
        <HeaderBrand linked={!locked} />
      </span>
    </>
  );
  return (
    <ModuleShell
      label="Tal till text"
      heading={heading}
      start={
        title &&
        (titleIsHeading ? (
          <Heading level={1} className={styles.belowLaptop}>
            {title}
          </Heading>
        ) : (
          <Text as="p" weight="semibold" type="large" className={styles.belowLaptop}>
            {title}
          </Text>
        ))
      }
      end={trailing ?? (account && <AccountMenu />)}
      height={fill ? "fill" : "auto"}
    >
      <div className={[styles.page, aside && styles.columns, fill && styles.fill].filter(Boolean).join(" ")}>
        {aside}
        {children}
      </div>
    </ModuleShell>
  );
}
