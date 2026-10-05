"use client";

import type { ComponentProps } from "react";
import { Card } from "@astryxdesign/core/Card";
import { VStack } from "@astryxdesign/core/VStack";

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
