"use client";

import type { ComponentProps } from "react";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { VStack } from "@astryxdesign/core/VStack";
import styles from "./StateCard.module.css";

/**
 * The old heading's class string, for the views not yet on the design system. Temporary: each view switches to
 * StateHeading when it is ported, and the last one deletes this.
 */
export const STATE_HEADING = "text-[22px] font-semibold tracking-[-0.01em] text-ink outline-none";

/** The heading of a state's card, which takes focus when the state appears (give it a ref and tabIndex -1). */
export function StateHeading({ level, ...props }: Omit<ComponentProps<typeof Heading>, "level"> & { level: 1 | 2 }) {
  return <Heading level={level} className={styles.heading} {...props} />;
}

/**
 * The card a flow's page shows a state in, beside the flow (ready, sending, running, failed): one state
 * replaces another in the same place.
 */
export function StateCard({ children, ...props }: ComponentProps<typeof Card>) {
  return (
    <Card padding={5} {...props}>
      <VStack gap={6}>{children}</VStack>
    </Card>
  );
}
