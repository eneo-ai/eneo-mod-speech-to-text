"use client";

import { ArrowLeft } from "lucide-react";
import type { MouseEvent } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { RouterLink } from "@/kit/RouterLink";

// The old buttons' names for the design system's: the filled one is the page's main action.
const VARIANT = { default: "primary", secondary: "secondary", outline: "secondary" } as const;
const SIZE = { default: "md", sm: "sm" } as const;

/**
 * The way back to the flow list, named the same on every page, a button that reads as one at rest. An action row
 * may give it more weight.
 */
export function BackToFlows({
  onLeave,
  variant = "secondary",
  size = "sm",
  className,
}: {
  /** Asked before leaving; call preventDefault to stay. */
  onLeave?: (event: MouseEvent) => void;
  variant?: keyof typeof VARIANT;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  return (
    <Button
      as={RouterLink}
      href="/flows"
      label="Alla flöden"
      icon={<Icon icon={ArrowLeft} />}
      variant={VARIANT[variant]}
      size={SIZE[size]}
      className={className}
      onClick={onLeave}
    >
      {/* A fragment, not the label's string: that makes the button name itself with aria-label. Its words are
          otherwise in a part a modal's aria-hiding (the old dialogs') leaves empty, because the button holds a live
          region that aria-hidden keeps visible, so the link stays and loses its name. */}
      <>Alla flöden</>
    </Button>
  );
}
