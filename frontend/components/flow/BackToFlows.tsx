import { ArrowLeft } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { RouterLink } from "@/kit/RouterLink";

/**
 * The way back to the flow list, named the same on every page, a button that reads as one at rest. An action row
 * may give it more weight.
 */
export function BackToFlows({
  variant = "secondary",
  size = "sm",
  className,
}: {
  /** The filled one is the page's main action. */
  variant?: "primary" | "secondary";
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <Button
      as={RouterLink}
      href="/flows"
      label="Alla flöden"
      icon={<Icon icon={ArrowLeft} />}
      variant={variant}
      size={size}
      className={className}
    >
      {/* A fragment, not the label's string: the button then names itself with aria-label. Inside an aria-hidden modal
          its words would be hidden while the button's live region stays visible, and the link would lose its name. */}
      <>Alla flöden</>
    </Button>
  );
}
